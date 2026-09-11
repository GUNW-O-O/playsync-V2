import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { WsGateway } from './ws.gateway';
import { WsTicketService } from './ws-ticket.service';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { DealerService } from 'src/dealer/dealer.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaClient, Role, TournamentStatus } from '@prisma/client';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { RecoveryService } from 'src/recovery/recovery.service';
import { TOURNAMENT_SYNCING_EVENT } from '@playsync/contract';

/**
 * 게이트웨이의 인바운드 경계.
 *
 * 여기가 유일하게 외부 입력이 들어오는 지점이다. 플레이어 단말은 좌석에 고정된
 * 태블릿이고 버튼과 슬라이더만 조작할 수 있지만, 그것은 UI의 제약이지 서버의
 * 제약이 아니다 — 망이 행사장 WiFi라 같은 망의 아무 단말이나 이 엔드포인트를
 * 직접 열 수 있다.
 */
describe('WsGateway 인바운드 경계', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let gateway: WsGateway;
  let tickets: WsTicketService;
  let playsync: PlaysyncService;
  let recovery: { completeSync: jest.Mock };
  let dealer: {
    startPreFlop: jest.Mock;
    resolveWinners: jest.Mock;
    handleDealerAction: jest.Mock;
  };

  const TABLE = 'table-1';
  const OTHER_TABLE = 'table-2';
  const TOURNAMENT = 'tournament-1';
  const ORIGIN = 'http://localhost:3000';

  function makePlayer(id: string, seatIndex: number): TablePlayer {
    return {
      id,
      tableId: TABLE,
      nickname: id,
      seatIndex,
      stack: 10000,
      bet: 0,
      hasFolded: false,
      hasChecked: false,
      isAllIn: false,
      totalContributed: 0,
    };
  }

  function makeState(): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: [makePlayer('alice', 0), makePlayer('bob', 1)],
      buttonUser: 0,
      currentTurnSeatIndex: 0,
      pot: 0,
      sidePots: [],
      currentBet: 100,
      smallBlind: 50,
      ante: 0,
      tournamentId: TOURNAMENT,
    };
  }

  /**
   * 최소한의 가짜 소켓. 거부는 close(1008)로 관찰한다.
   *
   * 닫힌 소켓에 send하면 던진다 — `ws`가 실제로 그렇게 동작한다. 브로드캐스트가
   * 이걸 걸러내지 않으면 죽은 소켓 하나가 루프를 중단시켜 뒤에 있는 멀쩡한
   * 클라이언트들이 상태를 못 받는다.
   */
  function makeClient(readyState = 1) {
    const client: any = {
      close: jest.fn(),
      send: jest.fn(() => {
        if (client.readyState !== 1) throw new Error('WebSocket is not open');
      }),
      // 진짜 `ws`에는 항상 있다. `handleConnection`이 pong을 배선하는 자리에서
      // 부른다(M6) — 없으면 `?.`로 건너뛰던 시절처럼 그 배선이 조용히 사라져도
      // 아무 테스트도 못 잡는다.
      on: jest.fn(),
      readyState,
    };
    return client;
  }

  function makeRequest(query: string, origin?: string) {
    return {
      url: `/playsync?${query}`,
      headers: origin ? { host: 'localhost', origin } : { host: 'localhost' },
    };
  }

  async function playerTicket(userId: string) {
    return tickets.issue({ sub: userId, role: Role.USER });
  }

  /**
   * 좌석 태블릿이 실제로 받는 티켓.
   *
   * `ws-ticket.controller.ts`의 `issue`가 `req.user.role`을 그대로 싣는데,
   * 좌석 토큰의 그 값은 Prisma `Role`이 아니라 `SEAT_ROLE`(`'PLAYER'`)이다.
   * 위 `playerTicket`은 `Role.USER`를 써 왔으므로 **프로덕션이 진짜로 싣는
   * 값을 한 번도 태워 보지 않았다**(T71 잔여 목록).
   */
  async function seatTicket(userId: string) {
    return tickets.issue({ sub: userId, role: SEAT_ROLE });
  }

  async function dealerTicket(tableId: string) {
    return tickets.issue({
      sub: 'dealer-session-1',
      role: Role.DEALER,
      tournamentId: TOURNAMENT,
      tableId,
    });
  }

  /** 접속에 성공해 테이블에 붙은 소켓을 돌려준다. */
  async function connect(ticket: string, tableId = TABLE, origin = 'http://localhost:3000') {
    const client = makeClient();
    await gateway.handleConnection(client, makeRequest(`tableId=${tableId}&ticket=${ticket}`, origin));
    return client;
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    tickets = new WsTicketService(redis);
    // 진짜 `PlaysyncService`를 쓴다. `assertTableAccess`(T66)가 진짜
    // Redis 스냅샷을 읽어 판정하므로, 목으로 두면 검증 대상인 그 대조 자체가
    // 사라진다 — `handleAction`만 스파이로 감싸 호출 여부·인자를 본다.
    playsync = new PlaysyncService(
      {} as unknown as Queue,
      new RedisService(redis),
      prisma as unknown as PrismaService,
      new EventEmitter2(),
    );
    jest.spyOn(playsync, 'handleAction').mockResolvedValue(makeState());
    dealer = {
      startPreFlop: jest.fn().mockResolvedValue(makeState()),
      resolveWinners: jest.fn().mockResolvedValue(makeState()),
      handleDealerAction: jest.fn().mockResolvedValue(makeState()),
    };
    // SYNCING 판정 자체는 게이트웨이가 메모리 소켓 수로 하고, `completeSync`는
    // "n/n이면 끝낸다"는 위임일 뿐이라 목이다 — 그 서비스의 원자성은
    // `recovery.service.int-spec.ts`가 따로 잰다.
    recovery = { completeSync: jest.fn().mockResolvedValue(true) };

    gateway = new WsGateway(
      dealer as unknown as DealerService,
      playsync,
      new RedisService(redis),
      tickets,
      new EventEmitter2(),
      // 대회 단위 접속의 자격은 서버가 들고 있는 관계(참가 행 · 상점 소유)로
      // 정한다. 목을 넣으면 검사 대상인 그 질의 자체가 사라지므로 진짜 DB다.
      prisma as unknown as PrismaService,
      recovery as unknown as RecoveryService,
    );
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
    await redis.set(`table:state:${OTHER_TABLE}`, JSON.stringify(makeState()));
    jest.clearAllMocks();
  });

  describe('접속 — 딜러 토큰', () => {
    it('토큰에 적힌 테이블에는 붙는다', async () => {
      const client = await connect(await dealerTicket(TABLE));
      expect(client.close).not.toHaveBeenCalled();
    });

    it('다른 테이블에는 붙을 수 없다', async () => {
      // 토큰의 tableId는 loginDealer가 서명해 넣은 값이고, 접속 쿼리의
      // tableId는 클라이언트가 고른 값이다. 대조하지 않으면 A테이블 딜러가
      // B테이블의 핸드 시작·킥·승자 지정 권한을 그대로 얻는다.
      const client = await connect(await dealerTicket(TABLE), OTHER_TABLE);
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('접속 — 플레이어 토큰', () => {
    it('자기 좌석이 있는 테이블에는 붙는다', async () => {
      const client = await connect(await playerTicket('alice'));
      expect(client.close).not.toHaveBeenCalled();
    });

    it('좌석이 없는 테이블에는 붙을 수 없다', async () => {
      // 인증만 되면 아무 tableId로나 붙어 renderGame을 전부 수신할 수 있었다.
      // 카드는 실물이라 홀카드는 새지 않지만 스택·팟·베팅·턴이 전부 나간다.
      await redis.set(
        `table:state:${OTHER_TABLE}`,
        JSON.stringify({ ...makeState(), players: [makePlayer('carol', 0)] }),
      );

      const client = await connect(await playerTicket('alice'), OTHER_TABLE);
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('존재하지 않는 테이블에는 붙을 수 없다', async () => {
      const client = await connect(await playerTicket('alice'), 'no-such-table');
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  /**
   * T45. 대회 단위 접속(`tournamentId`만 주고 `tableId`는 안 주는 접속)은
   * 좌석 현황 브로드캐스트(`renderSeatList`)를 구독한다. 테이블 경로는
   * `assertTableAccess`가 막는데 이 경로만 아무 대조도 없었다 — 인증만 되면
   * 아무 대회의 좌석 현황이나 실시간으로 받아볼 수 있었다.
   *
   * **티켓에 대회가 없는 것은 결함이 아니다.** `POST /ws/ticket`은 딜러
   * 티켓에만 `tournamentId`를 싣는다(`ws-ticket.controller.ts:41`) — 플레이어와
   * 상점은 한 사람이 여러 대회에 걸칠 수 있어 발급 시점에 대회를 정할 수 없다.
   * 그래서 딜러는 토큰 대조, 나머지는 서버가 들고 있는 관계(참가 행 · 상점
   * 소유)로 가른다.
   */
  describe('접속 — 대회 단위', () => {
    let seq = 0;

    /** 대회 하나와 그 상점 주인을 만든다. 참가자는 옵션이다. */
    async function seedTournament(opts: { participantId?: string } = {}) {
      seq += 1;
      const n = seq;
      const owner = await prisma.user.create({
        data: { nickname: `owner-${n}`, password: 'x', role: Role.STORE_ADMIN },
      });
      const store = await prisma.store.create({
        data: { name: `store-${n}`, ownerId: owner.id },
      });
      const blind = await prisma.blindStructure.create({
        data: {
          name: `blind-${n}`,
          storeId: store.id,
          structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
        },
      });
      const tournament = await prisma.tournament.create({
        data: {
          name: `대회-${n}`,
          storeId: store.id,
          blindId: blind.id,
          dealerOtpHash: 'unused-hash',
          startStack: 10000,
          avgStack: 10000,
          entryFee: 1000,
          rebuyUntil: 5,
          payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
          status: TournamentStatus.ONGOING,
          startedAt: new Date(),
        },
      });
      if (opts.participantId) {
        await prisma.user.create({
          data: { id: opts.participantId, nickname: opts.participantId, password: 'x' },
        });
        await prisma.tournamentParticipation.create({
          data: {
            userId: opts.participantId,
            tournamentId: tournament.id,
            playerOtp: `otp-${n}`,
          },
        });
      }
      return { tournamentId: tournament.id, ownerId: owner.id };
    }

    /** 대회 단위 접속. `tableId`를 주지 않는 것이 이 경로의 정의다. */
    async function connectTournament(ticket: string, tournamentId: string) {
      const client = makeClient();
      await gateway.handleConnection(
        client,
        makeRequest(`tournamentId=${tournamentId}&ticket=${ticket}`, 'http://localhost:3000'),
      );
      return client;
    }

    beforeEach(async () => {
      await truncateAll(prisma);
    });

    it('참가 중인 대회에는 붙는다', async () => {
      const { tournamentId } = await seedTournament({ participantId: 'alice' });

      const client = await connectTournament(await playerTicket('alice'), tournamentId);

      expect(client.close).not.toHaveBeenCalled();
    });

    it('참가하지 않은 대회에는 붙을 수 없다', async () => {
      // 인증만 되면 아무 대회의 좌석 현황이나 실시간으로 받을 수 있었다.
      // 좌석 배치는 그 대회에 누가 몇 명 남았는지를 그대로 드러낸다.
      const { tournamentId } = await seedTournament({ participantId: 'bob' });

      const client = await connectTournament(await playerTicket('alice'), tournamentId);

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('없는 대회에는 붙을 수 없다', async () => {
      const client = await connectTournament(await playerTicket('alice'), 'no-such-tournament');

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('대회를 여는 상점 주인은 참가 행이 없어도 붙는다', async () => {
      // 상점 콘솔과 전광판이 좌석 현황을 보는 화면이다. 주인은 참가자가
      // 아니므로 참가 행만 보면 자기 대회에서 잠긴다.
      const { tournamentId, ownerId } = await seedTournament();

      const client = await connectTournament(await tickets.issue({ sub: ownerId, role: Role.STORE_ADMIN }), tournamentId);

      expect(client.close).not.toHaveBeenCalled();
    });

    it('다른 상점의 주인은 붙을 수 없다', async () => {
      const { ownerId } = await seedTournament();
      const other = await seedTournament();

      const client = await connectTournament(await tickets.issue({ sub: ownerId, role: Role.STORE_ADMIN }), other.tournamentId);

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    /**
     * 딜러 티켓은 `tournamentId`를 들고 있다 — 로그인 시 서명된 값이라
     * 클라이언트가 고를 수 없다. 그쪽이 있으면 그것이 권위고, DB는 보지 않는다.
     * **참가 행 검사와 어긋나는 입력이다**: 딜러는 참가자가 아니라서, 대조
     * 없이 DB 검사만 하는 고침이면 여기가 빨개진다.
     */
    it('딜러 티켓은 토큰의 대회에 붙는다', async () => {
      const { tournamentId } = await seedTournament();
      const ticket = await tickets.issue({
        sub: 'dealer-session-1',
        role: Role.DEALER,
        tournamentId,
        tableId: TABLE,
      });

      const client = await connectTournament(ticket, tournamentId);

      expect(client.close).not.toHaveBeenCalled();
    });

    it('딜러 티켓으로 다른 대회에는 붙을 수 없다', async () => {
      // A 대회 티켓으로 붙으면서 쿼리에 B 대회를 주면 B의 좌석 현황을
      // 구독하게 됐다. 테이블 경로는 바로 아래에서 막는데 여기만 뚫려 있었다.
      const { tournamentId: mine } = await seedTournament();
      const { tournamentId: other } = await seedTournament();
      const ticket = await tickets.issue({
        sub: 'dealer-session-1',
        role: Role.DEALER,
        tournamentId: mine,
        tableId: TABLE,
      });

      const client = await connectTournament(ticket, other);

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('접속 — 티켓과 Origin', () => {
    it('티켓이 없으면 거부한다', async () => {
      const client = makeClient();
      await gateway.handleConnection(
        client,
        makeRequest(`tableId=${TABLE}`, 'http://localhost:3000'),
      );
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('없는 티켓을 거부한다', async () => {
      const client = await connect('no-such-ticket');
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('같은 티켓으로 두 번 붙을 수 없다', async () => {
      // 티켓이 재사용되면 로그나 페이지 소스에 남은 값 하나로 계속 붙을 수 있다.
      const ticket = await playerTicket('alice');

      const first = await connect(ticket);
      const second = await connect(ticket);

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('유효한 JWT를 token 쿼리로 넘겨도 붙을 수 없다', async () => {
      // 옛 경로가 살아 있으면 관찰 1(쿼리스트링 노출)과 10(httpOnly 무효화)이
      // 닫히지 않는다. 티켓을 도입해도 옛 문이 열려 있으면 아무것도 바뀌지 않는다.
      //
      // 지금 코드에서는 이 테스트가 바로 위 '티켓이 없으면 거부한다'와 같은
      // 경로(ticket 부재)를 탄다 — token 파라미터는 게이트웨이 어디서도 읽히지
      // 않는다. 그래도 이 테스트가 지키는 것은 실재한다: handleConnection에
      // token= 을 다시 읽어 티켓 검사 앞에서 신원을 세팅하고 접속시키는 옛
      // 분기를 되살려 돌려본 결과, 이 테스트만 유일하게 RED로 갈라졌다
      // (client.close가 전혀 호출되지 않음 — "Number of calls: 0"). 즉 이
      // 테스트는 지금은 다른 테스트와 같은 이유로 통과하지만, token 경로가
      // 되살아나는 회귀를 실제로 잡는다.
      const jwt = new JwtService({ secret: 'test-only-not-a-real-secret' });
      const token = jwt.sign({ sub: 'alice', nickname: 'alice', role: 'USER' });

      const client = makeClient();
      await gateway.handleConnection(
        client,
        makeRequest(`tableId=${TABLE}&token=${token}`, 'http://localhost:3000'),
      );

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('허용 목록에 없는 Origin을 거부한다', async () => {
      // 브라우저는 WebSocket에 same-origin을 강제하지 않는다. 다른 사이트가
      // 피해자 브라우저를 시켜 이 엔드포인트를 열게 하는 것을 막으려면
      // 핸드셰이크의 Origin을 직접 봐야 한다.
      const client = await connect(await playerTicket('alice'), TABLE, 'http://evil.example');
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('Origin이 없는 접속을 거부한다', async () => {
      // 실사용 클라이언트는 전부 브라우저다(좌석·딜러 태블릿 모두 Next 화면).
      // 헤더를 빼는 것은 브라우저를 경유하지 않는 접속뿐이고, 그것이 정확히
      // 이 검사가 막으려던 대상이다.
      const client = makeClient();
      await gateway.handleConnection(
        client,
        makeRequest(`tableId=${TABLE}&ticket=${await playerTicket('alice')}`),
      );
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('PLAYER_ACTION', () => {
    it('유효한 액션은 통과시킨다', async () => {
      const client = await connect(await playerTicket('alice'));

      await gateway.handlePlayerAction(client, { action: 'FOLD' });

      expect(playsync.handleAction).toHaveBeenCalledWith('alice', TABLE, { action: 'FOLD' });
    });

    it.each(['TIME_OUT', 'DEALER_KICK', 'DEALER_FOLD'])(
      '내부 전용 액션 %s를 거부한다',
      async (action) => {
        const client = await connect(await playerTicket('alice'));

        const result = await gateway.handlePlayerAction(client, { action });

        expect(playsync.handleAction).not.toHaveBeenCalled();
        expect(result?.event).toBe('error');
      },
    );

    it('서버가 읽지 않는 키가 섞이면 거부한다', async () => {
      // 프론트는 매 액션마다 token과 tableId를 실어 보냈지만 서버는 둘 다
      // 읽지 않는다 — 핸드셰이크에서 이미 검증했다.
      const client = await connect(await playerTicket('alice'));

      const result = await gateway.handlePlayerAction(client, {
        action: 'FOLD',
        token: 'ey...',
        tableId: TABLE,
      });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('금액 없는 RAISE를 거부한다', async () => {
      const client = await connect(await playerTicket('alice'));

      const result = await gateway.handlePlayerAction(client, { action: 'RAISE' });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('아무것도 바뀌지 않았으면 브로드캐스트를 시도조차 않는다', async () => {
      // 턴이 아닌 사람의 액션은 서비스가 조용히 무시하고 `null`을 돌려준다.
      // 그때도 전파하면 봇 하나가 30초마다 던지는 액션이 테이블 전원에게 같은
      // 스냅샷을 반복 배달하는 증폭기가 된다(T65).
      //
      // `send`만 보면 이 테스트는 고치기 전에도 통과한다 — `null`은 아웃바운드
      // 스키마에서 걸려 나가지 못하기 때문이다. 그래서 **걸러졌다는 증거**인
      // 계약 위반 로그가 없는 것까지 본다. 정상 경로라면 로그도 없어야 한다.
      const player = await connect(await playerTicket('alice'));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      (playsync.handleAction as jest.Mock).mockResolvedValueOnce(null);
      player.send.mockClear();

      await gateway.handlePlayerAction(player, { action: 'FOLD' });

      expect(player.send).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
      logged.mockRestore();
    });

    it('딜러 토큰으로는 플레이어 액션을 보낼 수 없다', async () => {
      const client = await connect(await dealerTicket(TABLE));

      const result = await gateway.handlePlayerAction(client, { action: 'FOLD' });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });
  });

  describe('DEALER_ACTION', () => {
    it('유효한 명령은 통과시킨다', async () => {
      const client = await connect(await dealerTicket(TABLE));

      await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(dealer.startPreFlop).toHaveBeenCalledWith(TOURNAMENT, TABLE);
    });

    it('플레이어 토큰으로는 보낼 수 없다', async () => {
      const client = await connect(await playerTicket('alice'));

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(dealer.startPreFlop).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('모르는 명령에 undefined를 브로드캐스트하지 않는다', async () => {
      // switch에 default가 없어서, 걸리지 않는 액션이 오면 updatedState가
      // undefined인 채로 테이블 전원에게 전송됐다.
      const client = await connect(await dealerTicket(TABLE));
      client.send.mockClear();

      const result = await gateway.handleDealerAction(client, { action: 'DROP_TABLE' });

      expect(result?.event).toBe('error');
      expect(client.send).not.toHaveBeenCalled();
    });

    it('빈 승자 목록을 거부한다', async () => {
      const client = await connect(await dealerTicket(TABLE));

      const result = await gateway.handleDealerAction(client, {
        action: 'RESOLVE_WINNERS',
        winnerUserIds: [],
      });

      expect(dealer.resolveWinners).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('서비스가 던진 에러를 잡아서 돌려준다', async () => {
      // 여기엔 try/catch가 없어서 휴식 중 START_PRE_FLOP 같은 정상적인 거절이
      // 처리되지 않은 rejection으로 새어 나갔다.
      const client = await connect(await dealerTicket(TABLE));
      dealer.startPreFlop.mockRejectedValueOnce(new Error('휴식 상태입니다.'));

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '휴식 상태입니다.' });
    });

    it('시작할 수 없는 상태는 에러로 돌아온다', async () => {
      // 예전에는 startPreFlop이 undefined를 반환했고 게이트웨이가 `if (updatedState)`로
      // 그걸 걸렀다. 지금은 실패가 예외로만 표현되므로 "상태 없이 성공한" 반환값
      // 자체가 존재하지 않는다 — 걸러낼 것이 없어졌다.
      const client = await connect(await dealerTicket(TABLE));
      dealer.startPreFlop.mockRejectedValueOnce(new Error('대기 상태가 아닙니다.'));
      client.send.mockClear();

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '대기 상태가 아닙니다.' });
      expect(client.send).not.toHaveBeenCalled();
    });
  });
  describe('딜러 명령 실패', () => {
    it('실패하면 아무에게도 브로드캐스트하지 않는다', async () => {
      // 조용한 return이 undefined를 만들어 renderGame으로 흘러가면, 테이블
      // 전원의 게임 상태가 undefined로 덮인다. 딜러의 실수 한 번에 전 화면이
      // 날아가는 셈이다.
      const dealerClient = await connect(await dealerTicket(TABLE));
      const player = await connect(await playerTicket('alice'));
      dealer.startPreFlop.mockRejectedValue(new Error('대기 상태가 아닙니다.'));
      jest.clearAllMocks();

      const res = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(res).toEqual({ event: 'error', data: '대기 상태가 아닙니다.' });
      expect(player.send).not.toHaveBeenCalled();
    });

    it('성공하면 테이블 전원에게 브로드캐스트한다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));
      const player = await connect(await playerTicket('alice'));
      dealer.startPreFlop.mockResolvedValue(makeState());
      jest.clearAllMocks();

      await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(player.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(player.send.mock.calls[0][0]);
      expect(sent.event).toBe('renderGame');
      expect(sent.data).not.toBeUndefined();
    });
  });

  /**
   * 아웃바운드 그물(T71 9-1).
   *
   * `table-state.ts`의 머리말은 "백엔드 `TableState`에 필드를 추가해도 여기
   * 없으면 조용히 제거된다"고 적는데, `TableStateSchema`의 프로덕션 사용처가
   * 0건이라 그 문장이 `renderGame` 경로에서 거짓이었다. 여기서 사실로 만든다.
   */
  describe('좌석 토큰의 역할', () => {
    it('좌석 티켓으로 자기 테이블에 붙는다', async () => {
      const client = await connect(await seatTicket('alice'));

      expect(client.close).not.toHaveBeenCalled();
    });

    it('좌석 티켓은 딜러 명령을 보낼 수 없다', async () => {
      // `SEAT_ROLE`은 `Role` enum 밖의 값이라 어떤 역할 검사와도 맞지 않는다
      // (`auth/seat-role.ts`). 게이트웨이도 같아야 한다.
      const client = await connect(await seatTicket('alice'));

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '딜러만 가능한 액션입니다.' });
    });
  });

  describe('아웃바운드 봉투', () => {
    /** 브로드캐스트로 실제로 나간 `renderGame`의 data. */
    function sentState(client: { send: jest.Mock }) {
      const payload = JSON.parse(client.send.mock.calls[0][0]);
      expect(payload.event).toBe('renderGame');
      return payload.data;
    }

    it('보내는 순간의 서버 시각을 찍는다', async () => {
      // 단말이 `actionDeadline`을 자기 시계와 직접 비교하면 시계가 어긋난
      // 태블릿에서 타이머가 틀린다. 스냅샷에는 없는 값이라 **내보낼 때**
      // 찍어야 한다.
      const player = await connect(await playerTicket('alice'));
      jest.clearAllMocks();
      const before = Date.now();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      const serverTime = sentState(player).serverTime;
      expect(typeof serverTime).toBe('number');
      expect(serverTime).toBeGreaterThanOrEqual(before);
      expect(serverTime).toBeLessThanOrEqual(Date.now());
    });

    it('내부 필드 timerEpoch를 실어 보내지 않는다', async () => {
      // 타이머 세대는 잡의 폐기 판정에만 쓰는 서버 내부값이다. 참가자 단말이
      // 알 이유가 없고, 계약에도 없다.
      const player = await connect(await playerTicket('alice'));
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({
        tableId: TABLE,
        state: { ...makeState(), timerEpoch: 7 },
      });

      expect(Object.keys(sentState(player))).not.toContain('timerEpoch');
    });

    it('좌석마다 반복되는 tableId를 실어 보내지 않는다', async () => {
      // 스냅샷 자체가 이미 그 테이블이다(`TablePlayerSchema`의 근거 주석).
      const player = await connect(await playerTicket('alice'));
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      const seated = sentState(player).players.filter((p: unknown) => p !== null);
      expect(seated.map((p: { tableId?: string }) => p.tableId)).toEqual([undefined, undefined]);
    });

    it('접속 직후 보내는 스냅샷도 같은 그물을 지난다', async () => {
      // 여기만 브로드캐스트가 아니라 본인에게 직접 보낸다. 경로가 달라도
      // 나가는 봉투는 같아야 한다.
      await redis.set(
        `table:state:${TABLE}`,
        JSON.stringify({ ...makeState(), timerEpoch: 7 }),
      );

      const player = await connect(await playerTicket('alice'));

      expect(Object.keys(sentState(player))).not.toContain('timerEpoch');
    });

    it('계약을 어기는 상태는 전파하지 않고 던지지도 않는다', async () => {
      // 음수 스택은 칩 정합이 깨졌다는 신호다. 깨진 상태를 태블릿에 그리는
      // 것보다 그리지 않는 편이 낫고, 던지면 `@OnEvent` 핸들러에서 처리되지
      // 않은 거부가 되어 테이블이 이유 없이 멈춘다.
      const player = await connect(await playerTicket('alice'));
      jest.clearAllMocks();

      const broken = makeState();
      broken.players[0]!.stack = -1;

      expect(() => gateway.handleGameStateUpdated({ tableId: TABLE, state: broken })).not.toThrow();
      expect(player.send).not.toHaveBeenCalled();
    });
  });

  describe('브로드캐스트 위생', () => {
    it('닫힌 소켓에는 보내지 않는다', async () => {
      const open = await connect(await playerTicket('alice'));
      const closed = await connect(await playerTicket('bob'));
      closed.readyState = 3;
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(open.send).toHaveBeenCalledTimes(1);
      expect(closed.send).not.toHaveBeenCalled();
    });

    it('앞선 소켓이 닫혀 있어도 뒤 소켓은 상태를 받는다', async () => {
      // 죽은 소켓에 send하면 ws가 던진다. forEach 안에서 던지면 루프가
      // 통째로 중단되어, 뒤에 있는 멀쩡한 클라이언트들이 상태를 못 받는다.
      const closed = await connect(await playerTicket('alice'));
      const open = await connect(await playerTicket('bob'));
      closed.readyState = 3;
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(open.send).toHaveBeenCalledTimes(1);
    });

    it('닫힌 소켓은 세션에서 정리된다', async () => {
      const closed = await connect(await playerTicket('alice'));
      await connect(await playerTicket('bob'));
      closed.readyState = 3;

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      // 정리됐다면 다시 열려도 이 테이블 브로드캐스트를 받지 않는다.
      closed.readyState = 1;
      jest.clearAllMocks();
      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(closed.send).not.toHaveBeenCalled();
    });
  });

  /**
   * 대회가 닫혔다는 알림.
   *
   * **테이블 방으로 간다.** 딜러와 좌석 태블릿이 거기 있고, 그들이 이 사실을
   * 모르면 끝난 대회의 마지막 스냅샷을 계속 그린다.
   *
   * 페이로드가 `tableIds`를 들고 오는 이유는 **부르는 쪽이 이미 `Table` 행을
   * 지웠기 때문**이다(`completeSession`의 트랜잭션). 게이트웨이가 나중에
   * 조회해서는 어느 방에 쏠지 알 길이 없다.
   */
  describe('대회가 닫히면 테이블 단말에 알린다', () => {
    it('그 대회의 테이블 소켓 전부가 받는다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));
      const player = await connect(await playerTicket('alice'));
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.FINISHED,
      });

      const seen = [dealerClient, player].map((c) => JSON.parse(c.send.mock.calls[0][0]));
      expect(seen.map((s) => `${s.event}/${s.data.status}/${s.data.tournamentId}`)).toEqual([
        `tournamentClosed/FINISHED/${TOURNAMENT}`,
        `tournamentClosed/FINISHED/${TOURNAMENT}`,
      ]);
    });

    /**
     * **다른 테이블은 안 받는다.** 상점 하나가 대회를 둘 열 수 있고, 옆
     * 대회의 딜러가 「끝났습니다」를 보면 돌던 판이 선다.
     */
    it('다른 테이블 소켓은 받지 않는다', async () => {
      const mine = await connect(await dealerTicket(TABLE), TABLE);
      const other = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.FINISHED,
      });

      expect(`내 ${mine.send.mock.calls.length} / 남 ${other.send.mock.calls.length}`)
        .toBe('내 1 / 남 0');
    });

    /**
     * **계약을 태운다.** 여기 실리는 값이 그대로 화면의 문장을 고르므로,
     * 살아 있는 상태가 새어 나가면 대회가 도는 채로 「끝났습니다」가 뜬다.
     * 스키마가 그 조합을 거부하고, 거부되면 아무것도 안 나간다.
     */
    it('닫힌 상태가 아니면 전파하지 않는다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.ONGOING,
      });

      expect(dealerClient.send).not.toHaveBeenCalled();
    });

    /**
     * **알린 뒤 끊는다.**
     *
     * 닫힌 대회의 소켓은 받을 것도 보낼 것도 없다 — 스냅샷이 지워져 밀어줄
     * 프레임이 없고, 무엇을 눌러도 돌아오는 것은 거절뿐이다. 열어 두면
     * 게이트웨이가 죽은 방을 들고 있게 된다.
     *
     * **코드 1000이라야 한다.** 단말의 `onclose`는 그 값만 정상 종료로 보고
     * 넘어간다(`DealerGameClient` · `SeatGameClient`). 다른 코드로 닫으면
     * 화면이 연결 끊김 배너를 그리고, **대회가 끝난 것과 망이 끊긴 것은
     * 딜러에게 전혀 다른 사건**이라 그 배너가 종료 덮개와 겹쳐 뜬다.
     */
    it('알린 뒤 소켓을 정상 종료로 닫는다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.FINISHED,
      });

      // 보낸 것이 먼저고 닫은 것이 나중이다. 순서가 뒤집히면 단말은 왜
      // 끊겼는지 모른 채 마지막 스냅샷을 그리고 있게 된다.
      const sent = JSON.parse(dealerClient.send.mock.calls[0][0]);
      expect(`${sent.event} → close(${dealerClient.close.mock.calls[0]?.[0]})`)
        .toBe('tournamentClosed → close(1000)');
    });

    /** 닫힌 방은 게이트웨이가 더 들고 있지 않는다. */
    it('닫은 방은 세션에서 정리된다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.FINISHED,
      });
      jest.clearAllMocks();
      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(dealerClient.send).not.toHaveBeenCalled();
    });

    /** 전파가 거부되면 끊지도 않는다. 대회는 그대로 돌고 있다. */
    it('닫힌 상태가 아니면 끊지 않는다', async () => {
      const dealerClient = await connect(await dealerTicket(TABLE));
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.ONGOING,
      });

      expect(dealerClient.close).not.toHaveBeenCalled();
    });

    /** 테이블이 여럿인 대회는 방마다 한 번씩 간다. */
    it('테이블이 여럿이면 각 방에 간다', async () => {
      const first = await connect(await dealerTicket(TABLE), TABLE);
      const second = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      jest.clearAllMocks();

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE, OTHER_TABLE],
        status: TournamentStatus.CANCELLED,
      });

      expect(`${first.send.mock.calls.length} / ${second.send.mock.calls.length}`).toBe('1 / 1');
    });
  });

  describe('좀비 소켓 청소 (T96)', () => {
    function makeLiveClient() {
      const handlers: Record<string, () => void> = {};
      const client: any = makeClient();
      client.ping = jest.fn();
      client.terminate = jest.fn(() => { client.readyState = 3; });
      client.on = jest.fn((ev: string, fn: () => void) => { handlers[ev] = fn; });
      client.pong = () => handlers.pong?.();
      return client;
    }

    it('pong을 안 한 테이블 소켓은 두 틱 뒤 끊고 방에서 뺀다. pong한 소켓은 살아서 keepalive를 받는다', async () => {
      // 위 beforeEach가 매 테스트 전에 TABLE 스냅샷을 이미 심어 둔다
      // (alice·bob이 그 players다) — 여기서 따로 심을 것이 없다.
      const zombie = makeLiveClient();
      const alive = makeLiveClient();
      await gateway.handleConnection(zombie, makeRequest(`tableId=${TABLE}&ticket=${await seatTicket('alice')}`, ORIGIN));
      await gateway.handleConnection(alive, makeRequest(`tableId=${TABLE}&ticket=${await seatTicket('bob')}`, ORIGIN));

      gateway.sweepSockets();
      alive.pong();
      gateway.sweepSockets();

      expect(zombie.terminate).toHaveBeenCalled();
      expect(alive.terminate).not.toHaveBeenCalled();
      expect(alive.send).toHaveBeenCalledWith(JSON.stringify({ event: 'keepalive' }));
      expect((gateway as any).tableSessions.get(TABLE)?.has(zombie)).toBe(false);
      expect((gateway as any).tableSessions.get(TABLE)?.has(alive)).toBe(true);
    });

    /**
     * M1-2. `sweepSockets`는 `tableSessions`와 `tournamentSessions` 두 맵을
     * 돈다(구현의 `for` 루프 둘). 위 테스트는 테이블 방만 접속시켜서, 대회
     * 방 루프를 통째로 지워도 이 파일이 전부 초록이었다 — T29와 같은 모양의
     * 구멍이다. 딜러 티켓은 `tournamentId`를 들고 있어(`loginDealer`가
     * 서명해 넣은 값) DB 조회 없이 대회 방에 붙을 수 있다.
     */
    it('대회 방(tournamentSessions)의 소켓도 청소 대상이다', async () => {
      const zombie = makeLiveClient();
      const alive = makeLiveClient();
      const zombieTicket = await tickets.issue({
        sub: 'dealer-session-2',
        role: Role.DEALER,
        tournamentId: TOURNAMENT,
      });
      const aliveTicket = await tickets.issue({
        sub: 'dealer-session-3',
        role: Role.DEALER,
        tournamentId: TOURNAMENT,
      });
      await gateway.handleConnection(zombie, makeRequest(`tournamentId=${TOURNAMENT}&ticket=${zombieTicket}`, ORIGIN));
      await gateway.handleConnection(alive, makeRequest(`tournamentId=${TOURNAMENT}&ticket=${aliveTicket}`, ORIGIN));

      gateway.sweepSockets();
      alive.pong();
      gateway.sweepSockets();

      expect(zombie.terminate).toHaveBeenCalled();
      expect(alive.terminate).not.toHaveBeenCalled();
      expect((gateway as any).tournamentSessions.get(TOURNAMENT)?.has(zombie)).toBe(false);
      expect((gateway as any).tournamentSessions.get(TOURNAMENT)?.has(alive)).toBe(true);
    });
  });

  /**
   * 서버 복구 중 딜러 복귀 k/n(T96). `RecoveryService`는 목이다 — 그
   * 서비스의 원자성(동시 n/n에 한쪽만 이긴다)은 `recovery.service.int-spec.ts`가
   * 잰다. 여기서 보는 것은 **게이트웨이가 소켓 수를 세어 판정하고, 판정에
   * 따라 알리고 명령을 거절하는가**다.
   */
  describe('SYNCING (T96)', () => {
    /** 대회 하나를 `id: TOURNAMENT`로 심는다. 딜러 티켓이 이미 그 값을 쓴다. */
    async function seedSyncingTournament(status: TournamentStatus = TournamentStatus.SYNCING) {
      const owner = await prisma.user.create({
        data: { nickname: 'sync-owner', password: 'x', role: Role.STORE_ADMIN },
      });
      const store = await prisma.store.create({ data: { name: 'sync-store', ownerId: owner.id } });
      const blind = await prisma.blindStructure.create({
        data: {
          name: 'sync-blind',
          storeId: store.id,
          structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
        },
      });
      await prisma.tournament.create({
        data: {
          id: TOURNAMENT,
          name: '동기화-대회',
          storeId: store.id,
          blindId: blind.id,
          dealerOtpHash: 'unused-hash',
          startStack: 10000,
          avgStack: 10000,
          entryFee: 1000,
          rebuyUntil: 5,
          payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
          status,
          startedAt: new Date(),
          pausedAt: status === TournamentStatus.SYNCING ? new Date() : null,
        },
      });
    }

    /** `TABLE`·`OTHER_TABLE` 둘 다 한 자리씩 앉힌다 — n(요구되는 테이블 수)이 2다. */
    async function seedSeats() {
      const redisService = new RedisService(redis);
      await redisService.rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);
      await redisService.rebuildSeatBitmap(TOURNAMENT, OTHER_TABLE, [0]);
    }

    /** 그 소켓에 마지막으로 나간 `tournamentSyncing`의 data. 없으면 `undefined`. */
    function lastSyncingPayload(client: { send: jest.Mock }) {
      const events = client.send.mock.calls
        .map(([raw]: [string]) => JSON.parse(raw))
        .filter((m: { event: string }) => m.event === TOURNAMENT_SYNCING_EVENT);
      return events.at(-1)?.data;
    }

    /** `pred`가 참이 될 때까지 짧게 반복해 기다린다. 실제 I/O(Redis·Prisma)가
     * 끝나는 시점을 폴링으로만 알 수 있는 아래 I1 테스트에서 쓴다. */
    async function waitUntil(pred: () => boolean, timeoutMs = 2000) {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    beforeEach(async () => {
      // 이 describe만 Prisma 대회 데이터를 쓴다. 마지막 describe라 다른
      // 테스트의 상태를 지울 걱정이 없다(`prisma`는 이 파일의 다른 describe와
      // 공유하지만, 그 describe들은 전부 이 앞에서 이미 끝났다).
      await truncateAll(prisma);

      // `gateway`는 이 파일 전체가 `beforeAll`에서 한 번 세운다 — 앞선
      // 60여 개 테스트가 TABLE·OTHER_TABLE에 붙인 소켓이 끊지 않은 채
      // `tableSessions`에 그대로 쌓여 있다. n/n 판정은 그 맵의 소켓 수를
      // 그대로 세므로, 지우지 않으면 이 describe의 present가 앞선 테스트의
      // 잔재만큼 부풀어 있다.
      (gateway as any).tableSessions.clear();
      (gateway as any).tournamentSessions.clear();
    });

    it('테이블 딜러가 접속하면 present 1/2를 알리고 completeSync는 안 부른다', async () => {
      await seedSyncingTournament();
      await seedSeats();

      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: true, present: 1, required: 2 });
      expect(recovery.completeSync).not.toHaveBeenCalled();
    });

    it('나머지 딜러까지 접속하면 completeSync를 부르고 두 딜러 모두 syncing:false를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();

      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 2, required: 2 });
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 2, required: 2 });
    });

    /**
     * Task4 M3(리뷰 권장, 최종 리뷰가 머지 가능으로 봤지만 한 줄이라 같이
     * 담는다). `completeSync`가 false를 돌려주면(동시 n/n의 진 쪽) 그
     * 재집계는 아무에게도 `syncing:false`를 보내지 않는다 — 이긴 쪽의
     * 재집계가 이미 보냈거나, 다음 재집계가 이어서 본다.
     */
    it('completeSync가 false를 돌려주면 syncing:false를 보내지 않는다(Task4 M3)', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      recovery.completeSync.mockResolvedValueOnce(false);

      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(otherDealer)).toBeUndefined();
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 2 });
    });

    /**
     * M4(최종 리뷰). 게이트웨이 통합 스펙의 나머지는 `RecoveryService`를
     * 목으로 둔다 — 그 서비스의 원자성(동시 n/n에 한쪽만 이긴다)은
     * `recovery.service.int-spec.ts`가 잰다. 여기 하나만 진짜
     * `RecoveryService`(Prisma·Redis는 이미 진짜다)를 물려 **게이트웨이 →
     * completeSync**의 실제 이음매가 도는지 본다 — 스펙 시나리오의 2·3단계가
     * 목 스펙에만 있었다는 것이 최종 리뷰 M4의 지적이다.
     */
    it('진짜 RecoveryService로 마지막 딜러가 접속하면 DB가 ONGOING·pausedAt null이 된다(M4)', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const realGateway = new WsGateway(
        dealer as unknown as DealerService,
        playsync,
        new RedisService(redis),
        tickets,
        new EventEmitter2(),
        prisma as unknown as PrismaService,
        new RecoveryService(prisma as unknown as PrismaService, new RedisService(redis)),
      );

      await realGateway.handleConnection(
        makeClient(),
        makeRequest(`tableId=${TABLE}&ticket=${await dealerTicket(TABLE)}`, ORIGIN),
      );
      await realGateway.handleConnection(
        makeClient(),
        makeRequest(`tableId=${OTHER_TABLE}&ticket=${await dealerTicket(OTHER_TABLE)}`, ORIGIN),
      );

      const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
      expect(`상태 ${t.status}`).toBe('상태 ONGOING');
      expect(t.pausedAt).toBeNull();
    });

    it('SYNCING인 동안 딜러 명령을 거절한다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      const result = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '딜러가 모두 돌아올 때까지 기다려 주세요.' });
      expect(dealer.startPreFlop).not.toHaveBeenCalled();
    });

    /**
     * 반대 입력: ONGOING이면 딜러 명령을 막지 않는다. 접속한 소켓 본인에게는
     * `{syncing:false,0,0}`이 한 번 간다(최종 리뷰 I2) — 이 소켓이 SYNCING을
     * 실제로 본 적이 없어도, 붙는 순간 "지금은 SYNCING이 아니다"를 스스로
     * 확인하게 만드는 자리다.
     */
    it('ONGOING이면 접속한 소켓에게만 syncing:false를 보내고 딜러 명령이 그대로 통과한다', async () => {
      await seedSyncingTournament(TournamentStatus.ONGOING);
      await seedSeats();

      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
      expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: false, present: 0, required: 0 });

      const result = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(dealer.startPreFlop).toHaveBeenCalledWith(TOURNAMENT, TABLE);
      expect(result).toBeUndefined();
    });

    /** 좌석 소켓(플레이어)은 딜러가 아니라 k에 안 든다. */
    it('좌석 소켓은 딜러 복귀로 세지 않는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      // OTHER_TABLE에는 플레이어(좌석) 소켓만 붙는다 — alice가 그 테이블
      // 스냅샷(top-level beforeEach)에 이미 앉아 있다.
      await connect(await playerTicket('alice'), OTHER_TABLE);

      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: true, present: 1, required: 2 });
    });

    it('딜러 소켓이 끊기면 남은 딜러가 줄어든 present를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      tableDealer.send.mockClear();

      await gateway.handleDisconnect(otherDealer);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 2 });
    });

    /**
     * 좌석이 SYNCING 중에 전부 풀리면(상점이 좌석을 해제하는 등) n이 0으로
     * 떨어진다. 접속·접속해제 어느 쪽도 일어나지 않으므로, `SEAT_LIST_UPDATED`가
     * 그 변화를 대신 알려야 한다 — 그렇지 않으면 이 대회는 다음 부팅까지
     * 영영 SYNCING에 머문다(컨트롤러 룰링 3).
     */
    it('앉은 사람이 없어지면(SEAT_LIST_UPDATED) 딜러 없이도 completeSync를 부른다', async () => {
      await seedSyncingTournament();
      // TABLE만 한 자리 앉히고 OTHER_TABLE은 아예 비운다 — n=1, 붙은 딜러는 0.
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);

      // 그 좌석을 뗀다. 딜러가 하나도 안 붙었으니 접속·접속해제 경로는 안 돈다.
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, []);
      const seatState = await new RedisService(redis).getTournamentTables(TOURNAMENT);
      await gateway.handleSeatListUpdated({ tournamentId: TOURNAMENT, state: seatState });

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
    });

    /**
     * 재리뷰 m3. `recount`의 송신 루프를 `required`(좌석이 찬 테이블만)로
     * 되돌려도 기존 테스트는 전부 초록이었다 — `required`에 없는 **빈**
     * 테이블에 붙은 딜러를 아무 테스트도 보지 않았기 때문이다. 그 딜러가
     * 바로 Task4 M2·I2가 고친 대상이다: 세는 집합(`required`)과 보내는
     * 집합(`seatMaps`)이 다르므로, 자기 테이블에 아직 아무도 안 앉았어도
     * 다른 테이블의 복귀 진행을 받아야 한다.
     */
    it('빈 테이블의 딜러도 required 밖에서 진행을 받고, 좌석이 풀리면 완료도 받는다(m3)', async () => {
      await seedSyncingTournament();
      // TABLE만 한 자리 앉힌다 — OTHER_TABLE은 비트맵은 있지만 전부 0이다.
      // (필드 자체가 없으면 `getTournamentTables`가 그 테이블을 읽지 않아
      // seatMaps에도 안 잡힌다 — 실제 운영에서는 테이블 생성 시점에 이미
      // 빈 비트맵이 깔려 있으므로 여기서도 명시적으로 세워 둔다.) n(required)=1.
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, OTHER_TABLE, []);

      // 옛 코드(`required`로 송신)라면 OTHER_TABLE은 required 밖이라
      // 이 딜러는 아무것도 못 받는다.
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: true, present: 0, required: 1 });

      // 좌석을 뗀다. 딜러 접속·접속해제 경로는 안 도므로 SEAT_LIST_UPDATED가
      // 대신 알린다(위 테스트와 같은 자리) — 이번엔 빈 테이블의 딜러가 실제로
      // 그 알림을 받는지까지 본다.
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, []);
      const seatState = await new RedisService(redis).getTournamentTables(TOURNAMENT);
      await gateway.handleSeatListUpdated({ tournamentId: TOURNAMENT, state: seatState });

      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 0, required: 0 });
    });

    /**
     * I1(리뷰). 판정이 끝나지 않은 재집계끼리는 「세고 → 곧바로 보낸다」가
     * 동기라 서로 어긋나지 않는다. 어긋나는 자리는 **끝난 판정의
     * `await completeSync` 창**이다 — 마지막 딜러 접속이 2/2를 세고
     * `completeSync`에 들어간 사이, 다른 딜러가 끊겨 새 재집계가 `SYNCING`을
     * (아직 커밋 전이라) 그대로 읽으면, 그 재집계가 나중에 `{syncing:false}`
     * 뒤에 낡은 `{syncing:true}`를 보낼 수 있다. 대회마다 `reportSync`를
     * 줄 세우면(`syncChains`) 뒤에 선 재집계는 앞선 것이 실제로 상태를
     * 커밋한 뒤에야 다시 읽으므로 `ONGOING`을 보고 조용히 돌아간다.
     *
     * **실제 Redis·Postgres 왕복 시간에 기대지 않는다.** 처음 이 테스트를
     * `completeSync`가 실제로 DB를 갱신하게 해서 짜 봤는데, 두 재집계가 실제
     * 인프라를 왕복하는 순서는 이 컨테이너에서는 항상 "좋은" 순서로
     * 끝났다(체이닝을 지워도 초록) — I1이 "확률은 낮다"고 적은 그 창이
     * 로컬 컨테이너에서는 그냥 안 열렸다. 그래서 상태 읽기
     * (`prisma.tournament.findUnique`)만 스파이로 확정적으로 바꾼다 —
     * `committed` 플래그가 실제 `completeSync`가 언젠가 상태를 커밋하는
     * 순간을 흉내낸다. 나머지(Redis 왕복, 소켓 전송)는 그대로 실제 경로다.
     */
    it('completeSync가 끝나기 전에 줄 선 재집계는 그 뒤에 낡은 syncing:true를 보내지 않는다(I1)', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);

      // `recount`가 읽는 상태를 확정적으로 통제한다. `committed`가 false인
      // 동안은 실제 DB와 같은 값(SYNCING)이고, completeSync가 "끝나면"
      // (아래에서 직접 뒤집는다) ONGOING이 된다 — 실제 서비스가 상태를
      // 커밋하는 것과 같은 관찰 결과를, 왕복 시간에 기대지 않고 낸다.
      let committed = false;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const originalFindUnique = prisma.tournament.findUnique.bind(prisma.tournament);
      const findUniqueSpy = jest
        .spyOn(prisma.tournament, 'findUnique')
        .mockImplementation((async (args: any) => {
          if (args?.where?.id === TOURNAMENT) {
            return { status: committed ? TournamentStatus.ONGOING : TournamentStatus.SYNCING };
          }
          return originalFindUnique(args);
        }) as any);

      // #1(마지막 딜러 접속)의 completeSync를 걸어 둔다 — 풀리면 위 플래그를
      // 뒤집는다(실제 서비스의 커밋 순간).
      let releaseCompleteSync: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseCompleteSync = resolve; });
      recovery.completeSync.mockImplementationOnce(async () => {
        await gate;
        committed = true;
        return true;
      });

      try {
        // #1: OTHER_TABLE 딜러가 접속해 2/2를 세고 completeSync에 들어간다.
        const connectPromise = connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
        await waitUntil(() => recovery.completeSync.mock.calls.length === 1);

        // #2: 그 사이 TABLE 딜러가 끊긴다 — 같은 대회 줄에 선다. 여기서
        // await하지 않는다 — 체이닝이 있으면 #1이 끝나기 전에는 #2의 재집계
        // 자체가 시작하지 않으므로, 여기서 기다리면 아래 `releaseCompleteSync`
        // 전에 테스트가 멈춘다. **되돌린(체이닝 없는) 버전에서는** 이 호출이
        // `recount`를 곧바로 부르고, 그 `findUnique`가 `committed`를
        // **아직 false인 채로** 동기적으로 읽는다 — 다음 줄에서 플래그를
        // 뒤집기 **전**이다.
        const disconnectPromise = gateway.handleDisconnect(tableDealer);
        // #1을 푼다.
        releaseCompleteSync();

        const [otherDealer] = await Promise.all([connectPromise, disconnectPromise]);

        expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 2, required: 2 });
      } finally {
        findUniqueSpy.mockRestore();
      }
    });
  });
});
