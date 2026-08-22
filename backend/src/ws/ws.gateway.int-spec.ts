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
  let dealer: {
    startPreFlop: jest.Mock;
    resolveWinners: jest.Mock;
    handleDealerAction: jest.Mock;
  };

  const TABLE = 'table-1';
  const OTHER_TABLE = 'table-2';
  const TOURNAMENT = 'tournament-1';

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

    gateway = new WsGateway(
      dealer as unknown as DealerService,
      playsync,
      new RedisService(redis),
      tickets,
      new EventEmitter2(),
      // 대회 단위 접속의 자격은 서버가 들고 있는 관계(참가 행 · 상점 소유)로
      // 정한다. 목을 넣으면 검사 대상인 그 질의 자체가 사라지므로 진짜 DB다.
      prisma as unknown as PrismaService,
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
          itmCount: 1,
          prizePayouts: [{ place: 1, percent: 100 }],
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
});
