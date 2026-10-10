import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
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
import { DEALER_REVOKED_REASON, SERVER_OUTAGE_EVENT, SERVER_RECOVERING_MESSAGE, TOURNAMENT_SYNCING_EVENT } from '@playsync/contract';

// 재집계 보류 창(T117)은 SyncQueue 단위 검사가 맡는다. 통합 검사는 `connect` 직후 결과를
// 읽으므로 게이트웨이를 보류 0으로 세운다 — `new WsGateway`보다 먼저 정해져야 한다.
process.env.SYNC_RECOUNT_HOLD_MS = '0';
// 스스로 닫은 마지막 딜러의 유예(T121)도 0으로 세운다 — 유예 자체는 그 describe가 값을 바꿔 잰다.
process.env.DEALER_GONE_GRACE_MS = '0';

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
  let recovery: { completeSync: jest.Mock; pauseForLineOutage: jest.Mock };
  let dealer: {
    startPreFlop: jest.Mock;
    resolveWinners: jest.Mock;
    handleDealerAction: jest.Mock;
    assertDealerSessionValid: jest.Mock;
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
  async function seatTicket(userId: string, version = 0) {
    // T110. 좌석 티켓은 대회와 세대를 싣고, 접속이 참가 행과 대조한다 — 행이
    // 없으면 거절이라 티켓을 내기 전에 행을 세운다.
    await ensureParticipation(userId, TOURNAMENT, version);
    return tickets.issue({
      sub: userId, role: SEAT_ROLE, tournamentId: TOURNAMENT, seatTokenVersion: version,
    });
  }

  /** 대회와 참가 행을 (없으면) 만든다. 이미 있으면 세대만 맞춘다. */
  async function ensureParticipation(userId: string, tournamentId: string, version: number) {
    await prisma.user.upsert({
      where: { id: 'gw-owner' }, update: {},
      create: { id: 'gw-owner', nickname: 'gw-owner', password: 'x', role: Role.STORE_ADMIN },
    });
    await prisma.store.upsert({
      where: { id: 'gw-store' }, update: {}, create: { id: 'gw-store', name: 'gw-store', ownerId: 'gw-owner' },
    });
    await prisma.blindStructure.upsert({
      where: { id: 'gw-blind' }, update: {},
      create: {
        id: 'gw-blind', name: 'gw-blind', storeId: 'gw-store',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
      },
    });
    await prisma.tournament.upsert({
      where: { id: tournamentId }, update: {},
      create: {
        id: tournamentId, name: tournamentId, storeId: 'gw-store', blindId: 'gw-blind',
        dealerOtpHash: 'unused-hash', startStack: 10000, entryFee: 1000,
        status: TournamentStatus.ONGOING,
      },
    });
    await prisma.user.upsert({
      where: { id: userId }, update: {}, create: { id: userId, nickname: userId, password: 'x' },
    });
    await prisma.tournamentParticipation.upsert({
      where: { tournamentId_userId: { tournamentId, userId } },
      update: { seatTokenVersion: version },
      create: { tournamentId, userId, playerOtp: `otp-${tournamentId}-${userId}`.slice(0, 40), seatTokenVersion: version },
    });
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

  /**
   * `pred`가 참이 될 때까지 짧게 반복해 기다린다. 실제 I/O(Redis·Postgres)나
   * 비동기 이벤트 핸들러(`outage.emit`)가 끝나는 시점을 폴링으로만 알 수
   * 있는 자리에서 쓴다 — 고정된 `setTimeout`은 느린 CI에서는 짧고 빠른
   * 로컬에서는 그냥 시간을 버린다(M4).
   */
  async function waitUntil(pred: () => boolean, timeoutMs = 2000) {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
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
      assertDealerSessionValid: jest.fn().mockResolvedValue(undefined),
    };
    // SYNCING 판정 자체는 게이트웨이가 메모리 소켓 수로 하고, `completeSync`는
    // "n/n이면 끝낸다"는 위임일 뿐이라 목이다 — 그 서비스의 원자성은
    // `recovery.service.int-spec.ts`가 따로 잰다.
    // `pauseForLineOutage`(T121)는 기본이 「못 멈췄다」다 — 앞선 테스트들이 ONGOING 대회의
    // 마지막 딜러를 끊어도 아무 일도 일어나지 않는다.
    recovery = {
      completeSync: jest.fn().mockResolvedValue(true),
      pauseForLineOutage: jest.fn().mockResolvedValue(false),
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

    /**
     * T117. `seedSeats`가 켠 자리(두 테이블의 0번)에 좌석 소켓을 붙인다 — 그 자리의
     * 주인은 최상위 `beforeEach`의 스냅샷에서 alice다. 필요한 기기는 테이블마다
     * 딜러 1 + 좌석 1이라 `seedSeats` 뒤에는 required가 4다.
     */
    async function connectSeats(tables: string[] = [TABLE, OTHER_TABLE]) {
      const clients: Awaited<ReturnType<typeof connect>>[] = [];
      for (const t of tables) clients.push(await connect(await seatTicket('alice'), t));
      return clients;
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

    it('테이블 딜러가 접속하면 present 1/4를 알리고 completeSync는 안 부른다', async () => {
      await seedSyncingTournament();
      await seedSeats();

      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: true, present: 1, required: 4 });
      expect(recovery.completeSync).not.toHaveBeenCalled();
    });

    it('좌석과 딜러가 다 붙으면 completeSync를 부르고 두 딜러 모두 syncing:false를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats();

      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
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
      await connectSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      recovery.completeSync.mockResolvedValueOnce(false);

      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(otherDealer)).toBeUndefined();
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 3, required: 4 });
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
      const realRecovery = new RecoveryService(prisma as unknown as PrismaService, new RedisService(redis));
      const realGateway = new WsGateway(
        dealer as unknown as DealerService,
        playsync,
        new RedisService(redis),
        tickets,
        new EventEmitter2(),
        prisma as unknown as PrismaService,
        realRecovery,
      );

      // 리뷰 I1. `WsGateway`·`RecoveryService` 둘 다 생성자에서 이 파일 전체가
      // 공유하는 `RedisOutage`(같은 `redis` 클라이언트, `outageOf`의 WeakMap)를
      // 구독한다 — 안 떼면 이 두 임시 인스턴스가 뒤에 오는 `Redis 장애 (T97)`·
      // `recovered 뒤...` 테스트의 `emit('down')`·`emit('recovered')`에도
      // 깨어나 대회 상태를 조용히 건드리고, 그 테스트들이 실은 이 리스너가
      // 대신 채워 준 값으로 통과하게 만든다.
      try {
        for (const t of [TABLE, OTHER_TABLE]) {
          await realGateway.handleConnection(
            makeClient(),
            makeRequest(`tableId=${t}&ticket=${await seatTicket('alice')}`, ORIGIN),
          );
        }
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
      } finally {
        realGateway.onModuleDestroy();
        realRecovery.onModuleDestroy();
      }
    });

    it('SYNCING인 동안 딜러 명령을 거절한다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      const result = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '모든 기기가 돌아올 때까지 기다려 주세요.' });
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

    /** T117. 좌석 소켓(플레이어)은 딜러가 아니어도 자기 자리로 k에 든다. */
    it('좌석 소켓은 자기 자리로 센다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      // OTHER_TABLE에는 플레이어(좌석) 소켓만 붙는다 — alice가 그 테이블
      // 스냅샷(top-level beforeEach)에 이미 앉아 있다.
      await connect(await playerTicket('alice'), OTHER_TABLE);

      const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: true, present: 2, required: 4 });
    });

    it('딜러 소켓이 끊기면 남은 딜러가 줄어든 present를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      tableDealer.send.mockClear();

      await gateway.handleDisconnect(otherDealer);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 4 });
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
     * T126 ②. 좌석 비트맵 해시를 **통째로** 잃으면(Redis 데이터 유실) 필요한 기기가
     * 0으로 읽혀 0/0이 「다 돌아왔다」가 됐다 — 어느 테이블도 못 도는데 대회가 풀리고
     * 블라인드 시계가 흘렀다. 테이블이 있는 대회는 빈 테이블도 해시에 자리가 있으므로
     * (위 검사가 반대 입력이다), 해시가 비었는데 DB에 테이블이 있으면 유실이다.
     * 풀지 않고 둔다 — 상점의 「지금 진행」은 여전히 열려 있다.
     */
    it('좌석 비트맵을 통째로 잃었으면 0/0이어도 스스로 풀지 않는다', async () => {
      await seedSyncingTournament();
      const session = await prisma.dealerSession.create({ data: { tournamentId: TOURNAMENT } });
      await prisma.table.create({ data: { id: TABLE, tableOrder: 1, tournamentId: TOURNAMENT, dealerId: session.id } });

      await gateway.handleSeatListUpdated({ tournamentId: TOURNAMENT, state: [] });

      expect(`completeSync ${recovery.completeSync.mock.calls.length}번`).toBe('completeSync 0번');
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
      // 빈 비트맵이 깔려 있으므로 여기서도 명시적으로 세워 둔다.) n(required)=2 — TABLE 딜러 + 0번 좌석.
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);
      await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, OTHER_TABLE, []);

      // 옛 코드(`required`로 송신)라면 OTHER_TABLE은 required 밖이라
      // 이 딜러는 아무것도 못 받는다.
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: true, present: 0, required: 2 });

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
     * `await completeSync` 창**이다 — 마지막 딜러 접속이 4/4를 세고
     * `completeSync`에 들어간 사이, 다른 딜러가 끊겨 새 재집계가 `SYNCING`을
     * (아직 커밋 전이라) 그대로 읽으면, 그 재집계가 나중에 `{syncing:false}`
     * 뒤에 낡은 `{syncing:true}`를 보낼 수 있다. 대회마다 `reportSync`를
     * 줄 세우면(`SyncQueue`) 뒤에 선 재집계는 앞선 것이 실제로 상태를
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
      await connectSeats();
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
        // #1: OTHER_TABLE 딜러가 접속해 4/4를 세고 completeSync에 들어간다.
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

        expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      } finally {
        findUniqueSpy.mockRestore();
      }
    });

    /**
     * T97. Redis 복구가 끝난 뒤(`outage`의 `recovered`)에도 n/n 재집계는
     * 부팅 뒤와 같은 함수(`reportSync`)를 탄다 — 소켓이 안 끊겼으므로
     * 딜러 둘이 이미 붙어 있으면 곧바로 찬다.
     */
    it('recovered 뒤 딜러가 이미 n/n이면 completeSync를 부른다(T97)', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      jest.clearAllMocks();

      (gateway as any).redis.outage.emit('recovered');
      await waitUntil(() => recovery.completeSync.mock.calls.length > 0);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
    });

    /**
     * 최종 리뷰 I1. `recovering`인 동안 마지막 딜러가 붙어 n/n을 채워도
     * `completeSync`가 불리면 안 된다 — 복구 스윕이 아직 이 대회를 얼리기
     * 전이라, 여기서 대회가 `ONGOING`이 되면 그 스윕이 이 대회를 지나쳐
     * 낡은 마감이 남는다(T97 결함의 재발). `phase`를 `recovering`으로
     * 두는 것은 위 「Redis 장애 (T97)」describe와 같은 방식이다 — 전이
     * 자체는 `redis/outage.spec.ts`가 이미 검증하므로 여기서는 게이트웨이가
     * 그 상태를 읽는지만 본다.
     */
    it('recovering 동안 n/n이 채워져도 completeSync를 부르지 않고 SYNCING에 머문다(최종 리뷰 I1)', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 3, required: 4 });

      const outage = (gateway as any).redis.outage;
      try {
        outage.phase = 'recovering';
        const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

        expect(recovery.completeSync).not.toHaveBeenCalled();
        const stillSyncing = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
        expect(`상태 ${stillSyncing.status}`).toBe(`상태 ${TournamentStatus.SYNCING}`);
        // recount 자체가 phase 가드에서 곧바로 돌아가므로 이 소켓은 아무
        // tournamentSyncing도 못 받는다 — outage 배너가 대신 화면을 막는다.
        expect(lastSyncingPayload(otherDealer)).toBeUndefined();

        // `markRecovered`가 하는 것과 같은 순서: phase를 `up`으로 되돌린
        // 뒤 `recovered`를 쏜다. `afterOutage`가 SYNCING 대회를 다시 훑어
        // `reportSync`를 불러 이번엔 completeSync가 돈다(반대 입력 —
        // up이면 완료한다).
        outage.phase = 'up';
        outage.emit('recovered');
        await waitUntil(() => recovery.completeSync.mock.calls.length > 0);

        expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
        expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 4, required: 4 });
        expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      } finally {
        outage.phase = 'up';
      }
    });

    /**
     * **끊긴 딜러를 `broadcast`가 먼저 치워도 재집계가 돈다**(T96 잔여).
     *
     * 예전에는 「두 번 불림」 가드를 `Set.delete`의 반환값으로 했다. 그런데
     * 방에서 빼는 자리가 `handleDisconnect`만이 아니다 — `broadcast`가 OPEN이
     * 아닌 소켓을 그 자리에서 지운다. 그러면 뒤이은 진짜 `handleDisconnect`가
     * `delete === false`를 보고 **재집계를 통째로 건너뛰어**, 「k/n 복귀」
     * 표시가 다음 이벤트까지 높게 남았다.
     *
     * 여기서는 그 순서를 그대로 만든다 — 딜러 소켓을 죽은 상태로 만들고
     * `broadcast`를 한 번 태워 방에서 빠지게 한 뒤에 `handleDisconnect`를
     * 부른다. 남은 딜러 하나가 새 집계(1/4)를 받아야 한다.
     */
    it('broadcast가 먼저 방에서 뺀 딜러도 끊기면 집계가 다시 돈다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const leaving = await connect(await dealerTicket(TABLE), TABLE);
      const staying = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
      const countSyncing = (c: { send: jest.Mock }) => c.send.mock.calls
        .map(([raw]: [string]) => JSON.parse(raw))
        .filter((m: { event: string }) => m.event === TOURNAMENT_SYNCING_EVENT).length;
      const before = countSyncing(staying);

      // 소켓이 죽는다. `broadcast`가 먼저 훑어 방에서 빼 간다.
      (leaving as any).readyState = 3;   // WebSocket.CLOSED
      (gateway as any).broadcast(
        (gateway as any).tableSessions.get(TABLE), 'renderGame', {},
      );
      expect((gateway as any).tableSessions.get(TABLE)?.has(leaving) ?? false).toBe(false);

      await gateway.handleDisconnect(leaving as never);

      // **알림이 한 번 더 나갔다는 것이 요점이다.** 값만 보면 「안 돌았다」와
      // 「돌았는데 값이 같다」를 못 가른다 — 고치기 전에는 0건이었다.
      // (`completeSync`는 이 스펙에서 목이라 DB는 SYNCING에 남아 있고,
      //  그래서 딜러가 하나 빠진 지금 다시 세면 1/4이다.)
      expect(`늘어난 알림 ${countSyncing(staying) - before}`).toBe('늘어난 알림 1');
      expect(lastSyncingPayload(staying)).toEqual({ syncing: true, present: 1, required: 4 });
    });

    /** T117. 옛 판정(딜러만)이면 여기서 completeSync가 불려 대회가 열렸다. */
    it('딜러가 다 와도 좌석 하나가 없으면 SYNCING에 머물고 딜러 명령을 거절한다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      expect(recovery.completeSync).not.toHaveBeenCalled();
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 3, required: 4 });
      const result = await gateway.handleDealerAction(tableDealer, { action: 'START_PRE_FLOP' });
      expect(result).toEqual({ event: 'error', data: '모든 기기가 돌아올 때까지 기다려 주세요.' });
    });

    it('마지막 좌석이 붙으면 completeSync를 부르고 딜러들이 syncing:false를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

      await connectSeats([OTHER_TABLE]);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 4, required: 4 });
      expect(lastSyncingPayload(otherDealer)).toEqual({ syncing: false, present: 4, required: 4 });
    });

    /** **반대 입력.** bob은 스냅샷 1번이지만 비트맵은 0번만 켰다 — 필요 없는 자리다. */
    it('비트맵에 없는 자리의 좌석 소켓은 세지 않는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connect(await seatTicket('bob'), TABLE);
      await connect(await seatTicket('bob'), OTHER_TABLE);

      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 4 });
    });

    it('좌석 소켓이 끊기면 딜러가 줄어든 present를 받는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const [tableSeat] = await connectSeats([TABLE]);
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 2, required: 4 });

      await gateway.handleDisconnect(tableSeat);

      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: true, present: 1, required: 4 });
    });

    it('syncStatus는 안 돌아온 자리를 낸다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      await connectSeats([TABLE]);
      await connect(await dealerTicket(TABLE), TABLE);

      expect(await gateway.syncStatus(TOURNAMENT)).toEqual({
        syncing: true, present: 2, required: 4,
        missing: [{ tableId: OTHER_TABLE, seatIndex: null }, { tableId: OTHER_TABLE, seatIndex: 0 }],
      });
    });

    it('SYNCING이 아니면 syncStatus는 비어 있다', async () => {
      await seedSyncingTournament(TournamentStatus.ONGOING);
      expect(await gateway.syncStatus(TOURNAMENT)).toEqual({ syncing: false, present: 0, required: 0, missing: [] });
    });

    it('forceSync는 completeSync를 부르고 딜러들에게 syncing:false를 보낸다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);

      expect(await gateway.forceSync(TOURNAMENT, 'owner-1')).toBe(true);

      expect(recovery.completeSync).toHaveBeenCalledWith(TOURNAMENT);
      expect(lastSyncingPayload(tableDealer)).toEqual({ syncing: false, present: 1, required: 4 });
    });

    /** 자연 완료와 겹쳐 진 쪽이거나 이미 풀린 대회 — 아무에게도 보내지 않는다. */
    it('forceSync는 SYNCING이 아니거나 completeSync가 지면 false다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
      tableDealer.send.mockClear();
      recovery.completeSync.mockResolvedValueOnce(false);

      expect(await gateway.forceSync(TOURNAMENT, 'owner-1')).toBe(false);
      expect(lastSyncingPayload(tableDealer)).toBeUndefined();

      await prisma.tournament.update({ where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING, pausedAt: null } });
      recovery.completeSync.mockClear();
      expect(await gateway.forceSync(TOURNAMENT, 'owner-1')).toBe(false);
      expect(recovery.completeSync).not.toHaveBeenCalled();
    });

    it('진짜 RecoveryService로 forceSync하면 DB가 ONGOING이 되고 두 번째는 false다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const realRecovery = new RecoveryService(prisma as unknown as PrismaService, new RedisService(redis));
      const realGateway = new WsGateway(
        dealer as unknown as DealerService, playsync, new RedisService(redis), tickets,
        new EventEmitter2(), prisma as unknown as PrismaService, realRecovery,
      );
      try {
        expect(await realGateway.forceSync(TOURNAMENT, 'owner-1')).toBe(true);
        const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
        expect(`상태 ${t.status} ${t.pausedAt}`).toBe('상태 ONGOING null');
        expect(await realGateway.forceSync(TOURNAMENT, 'owner-1')).toBe(false);
      } finally {
        realGateway.onModuleDestroy();
        realRecovery.onModuleDestroy();
      }
    });

    /** Redis 장애 중에는 풀지 않는다 — 복구 스윕이 SYNCING 대회를 얼리기 전에 ONGOING이 되면 안 된다(T97 최종 리뷰 I1). */
    it('forceSync는 Redis가 recovering이면 503이고 completeSync를 부르지 않는다', async () => {
      await seedSyncingTournament();
      await seedSeats();
      const outage = (gateway as any).redis.outage;
      try {
        outage.phase = 'recovering';
        await expect(gateway.forceSync(TOURNAMENT, 'owner-1')).rejects.toThrow(ServiceUnavailableException);
        expect(recovery.completeSync).not.toHaveBeenCalled();
      } finally {
        outage.phase = 'up';
      }
    });

    /**
     * 대회장의 회선이 끊겼다(T121). 서버가 볼 수 있는 것은 「그 대회의 딜러 소켓이
     * 하나도 안 남았다」뿐이다 — 그때 그 대회를 멈춘다. 멈추는 일 자체는
     * `recovery.service.int-spec.ts`가 재고, 여기서는 **언제 부르는가**를 본다.
     */
    describe('회선 끊김 (T121)', () => {
      const linePause = () => (gateway as any).redis.linePause as import('src/redis/line-pause').LinePause;
      // 게이트웨이는 파일 전체가 하나다. 앞선 테스트가 끊은 딜러의 시각이 남아 있으면
      // 「마지막으로 응답한 시각」이 그쪽으로 잡힌다(최댓값이다).
      const GRACE_MS = 40;
      beforeEach(() => {
        (gateway as any).lastDealerSeenAt.clear();
        // 앞선 `forceSync` 검사가 남긴 시각도 같은 이유로 지운다(T126).
        (gateway as any).forcedAt.clear();
        (gateway as any).dealerGoneGraceMs = GRACE_MS;
      });
      afterEach(() => {
        linePause().clearAll();
        (gateway as any).dealerGoneGraceMs = 0;
      });
      /** 회선이 말없이 끊겼다 — 서버가 응답 없는 소켓을 끊은 모양(`sweepSockets`). */
      const lineDrop = (client: any) => { client.swept = true; return gateway.handleDisconnect(client); };
      const pauses = () => recovery.pauseForLineOutage.mock.calls.length;

      it('마지막 딜러가 끊기면 그 대회를 멈춘다 — 한 대라도 남으면 안 멈춘다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
        const otherDealer = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

        await lineDrop(otherDealer);
        expect(`한 대 남음 ${recovery.pauseForLineOutage.mock.calls.length}`).toBe('한 대 남음 0');

        await lineDrop(tableDealer);
        expect(`전부 끊김 ${recovery.pauseForLineOutage.mock.calls.length}`).toBe('전부 끊김 1');
        expect(recovery.pauseForLineOutage).toHaveBeenCalledWith(TOURNAMENT, expect.any(Date));
      });

      /** 빈 테이블은 n/n에는 안 들지만, 그 딜러가 붙어 있다는 것은 회선이 살아 있다는 증거다. */
      it('빈 테이블의 딜러 한 대도 남은 것이다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);
        const tableDealer = await connect(await dealerTicket(TABLE), TABLE);
        await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);

        await lineDrop(tableDealer);

        expect(recovery.pauseForLineOutage).not.toHaveBeenCalled();
      });

      it('좌석만 전부 끊겨도 안 멈춘다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        await connect(await dealerTicket(TABLE), TABLE);
        const seats = await connectSeats();

        for (const seat of seats) await gateway.handleDisconnect(seat);

        expect(recovery.pauseForLineOutage).not.toHaveBeenCalled();
      });

      /**
       * 줄을 기다리는 사이 딜러가 돌아왔으면 끊긴 것이 아니다(새로고침). 타이밍에
       * 맡기지 않고 줄을 붙잡아 순서를 강제한다.
       */
      it('줄을 기다리는 사이 딜러가 붙으면 안 멈춘다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
        let release!: () => void;
        const held = (gateway as any).syncQueue.enqueue(TOURNAMENT, () => new Promise<void>((r) => { release = r; }));

        const gone = lineDrop(dealerClient);
        const back = connect(await dealerTicket(TABLE), TABLE);
        await waitUntil(() => [...((gateway as any).tableSessions.get(TABLE) ?? [])].some((s: any) => s.role === Role.DEALER));
        release();
        await Promise.all([held, gone, back]);

        expect(recovery.pauseForLineOutage).not.toHaveBeenCalled();
      });

      /** Redis 장애는 `onRedisDown`이 이미 전 대회를 켰다 — 이 길이 `pausedAt`을 다투지 않는다. */
      it('Redis 장애 중의 딜러 끊김은 이 길로 멈추지 않는다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
        const outage = (gateway as any).redis.outage;
        try {
          outage.phase = 'down';
          await lineDrop(dealerClient);
          expect(recovery.pauseForLineOutage).not.toHaveBeenCalled();
        } finally {
          outage.phase = 'up';
        }
      });

      it('응답이 없어 끊은 딜러는 마지막으로 응답한 시각부터, 스스로 닫은 딜러는 지금부터 멈춘 것이다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const lastPong = Date.now() - 15_000;

        const swept = await connect(await dealerTicket(TABLE), TABLE);
        swept.aliveAt = lastPong;
        swept.swept = true;
        await gateway.handleDisconnect(swept);

        const closed = await connect(await dealerTicket(TABLE), TABLE);
        closed.aliveAt = lastPong;
        await gateway.handleDisconnect(closed);
        await waitUntil(() => pauses() === 2);

        const [[, first], [, second]] = recovery.pauseForLineOutage.mock.calls as [string, Date][];
        expect(`끊음 ${first.getTime() === lastPong} 닫음 ${second.getTime() > lastPong + 10_000}`)
          .toBe('끊음 true 닫음 true');
      });

      /**
       * **새로고침으로 대회가 멈추면 안 된다.** 테이블이 하나인 대회와 파이널 테이블에서는
       * 딜러가 한 대라, 화면을 다시 여는 것만으로 「딜러 0」이 된다. 스스로 닫은 소켓은
       * 유예(`DEALER_GONE_GRACE_MS`) 뒤에 여전히 딜러가 없을 때만 멈춘다.
       */
      it('스스로 닫은 마지막 딜러가 유예 안에 돌아오면 안 멈춘다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

        await gateway.handleDisconnect(dealerClient);
        await connect(await dealerTicket(TABLE), TABLE);
        await new Promise((r) => setTimeout(r, GRACE_MS * 4));

        expect(`새로고침 ${pauses()}`).toBe('새로고침 0');
      });

      /** 반대 입력 — 「스스로 닫으면 절대 안 멈춘다」가 위를 통과한다. 닫고 안 돌아오면 멈춘다. */
      it('스스로 닫고 유예가 지나도록 안 돌아오면 멈춘다 — 유예 전에는 아니다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

        await gateway.handleDisconnect(dealerClient);
        expect(`닫은 직후 ${pauses()}`).toBe('닫은 직후 0');

        await waitUntil(() => pauses() === 1);
      });

      /** 서버가 내보낸 딜러(딜러 OTP 재발급 · 기기 해제)는 돌아올 새로고침이 아니다. */
      it('서버가 내보낸 마지막 딜러는 유예 없이 멈춘다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        (gateway as any).dealerGoneGraceMs = 60_000;
        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

        gateway.handleDealerSessionRevoked({ tournamentId: TOURNAMENT });
        await gateway.handleDisconnect(dealerClient);

        expect(`내보냄 ${pauses()}`).toBe('내보냄 1');
      });

      /**
       * 접속에서 거절된 딜러 소켓은 딜러였던 적이 없다. 딜러가 아직 아무도 안 붙은 진행 중
       * 대회에서 낡은 토큰 하나가 거절됐다고 대회가 멈추면 안 된다.
       */
      it('접속에서 거절된 딜러 소켓은 대회를 멈추지 않는다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        await seedSeats();
        (gateway as any).dealerGoneGraceMs = 0;
        // 첫 대조는 통과하고 방에 넣은 뒤의 대조에서 거절된다 — 이때는 소켓에 역할과
        // 대회가 이미 적혀 있어, 「딜러였나」를 따로 안 보면 이 끊김이 판정을 부른다.
        dealer.assertDealerSessionValid
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new ForbiddenException('내보내진 딜러'));

        const rejected = await connect(await dealerTicket(TABLE), TABLE);

        expect(`거절 ${rejected.close.mock.calls.length} 멈춤 ${pauses()}`).toBe('거절 1 멈춤 0');
      });

      /**
       * **딜러만 빠르게 확인한다.** 10초 주기의 청소로는 회선이 끊긴 것을 10~20초 뒤에
       * 알고, 그 사이 마감이 온 사람이 접힌다. 딜러 소켓은 2초마다 따로 확인해 그 대회의
       * 딜러가 전부 침묵이면 **소켓이 아직 열려 있어도** 멈춘다.
       */
      describe('딜러 빠른 확인', () => {
        /** 그 소켓이 pong을 보냈다 — `handleConnection`이 건 핸들러를 부른다. */
        const pong = (client: any) => client.on.mock.calls.find(([name]: [string]) => name === 'pong')[1]();
        /** 확인 한 번. 줄에 선 판정까지 기다린다. */
        const probeOnce = async () => { gateway.probeDealers(); await (gateway as any).syncQueue.enqueue(TOURNAMENT, async () => {}); };
        const longAgo = () => Date.now() - 60_000;

        it('그 대회의 딜러가 연달아 두 번 답이 없으면 멈춘다 — 한 번으로는 아니고, 소켓은 끊지 않는다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
          const lastSeen = longAgo();
          dealerClient.aliveAt = lastSeen;
          dealerClient.terminate = jest.fn();
          dealerClient.ping = jest.fn();

          await probeOnce();              // 첫 확인을 보낸다
          await probeOnce();              // 답이 없었다 (1)
          expect(`한 번 ${pauses()}`).toBe('한 번 0');
          await probeOnce();              // 또 없었다 (2)

          expect(`두 번 ${pauses()} 끊음 ${dealerClient.terminate.mock.calls.length} 방에 ${(gateway as any).tableSessions.get(TABLE)?.has(dealerClient)}`)
            .toBe('두 번 1 끊음 0 방에 true');
          const [[, pausedAt]] = recovery.pauseForLineOutage.mock.calls as [string, Date][];
          expect(`마지막 응답부터 ${pausedAt.getTime() === lastSeen}`).toBe('마지막 응답부터 true');
        });

        /**
         * T126 ①. 회선이 죽은 채 상점이 「지금 진행」을 눌렀다. 딜러 소켓은 청소 전이라
         * 아직 열려 있고 침묵 중이다 — 다음 확인 틱이 같은 「마지막으로 응답한 시각」으로
         * 대회를 다시 멈췄다. 상점의 결정이 몇 초 만에 무효가 되고, 그 구간이 정지
         * 시간에 두 번 더해졌다. 푼 뒤로 답한 딜러가 없으면 다시 멈추지 않는다.
         */
        it('상점이 강제로 푼 뒤에는 같은 침묵으로 다시 멈추지 않는다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);
          dealerClient.aliveAt = longAgo();
          dealerClient.ping = jest.fn();
          for (let i = 0; i < 3; i++) await probeOnce();
          expect(`멈춤 ${pauses()}`).toBe('멈춤 1');

          await prisma.tournament.update({
            where: { id: TOURNAMENT }, data: { status: TournamentStatus.SYNCING, pausedAt: new Date() },
          });
          expect(await gateway.forceSync(TOURNAMENT, 'owner-1')).toBe(true);
          await prisma.tournament.update({
            where: { id: TOURNAMENT }, data: { status: TournamentStatus.ONGOING, pausedAt: null },
          });

          for (let i = 0; i < 3; i++) await probeOnce();
          expect(`푼 뒤 멈춤 ${pauses()}`).toBe('푼 뒤 멈춤 1');

          // 반대쪽 — 딜러가 돌아왔다가 다시 사라지면 그때는 멈춘다.
          pong(dealerClient);
          dealerClient.aliveAt = Date.now();
          await new Promise((r) => setTimeout(r, 5));
          for (let i = 0; i < 3; i++) await probeOnce();
          expect(`돌아왔다 다시 사라짐 ${pauses()}`).toBe('돌아왔다 다시 사라짐 2');
        });

        /**
         * T126 ④. 대회가 닫히면 회선 기록을 버린다. 그런데 닫힘이 딜러 소켓을 닫고,
         * 그 끊김이 기록을 다시 적고 유예 타이머까지 걸었다 — 닫힌 대회의 항목이
         * 프로세스가 내려갈 때까지 남았다.
         */
        it('대회가 닫혀서 끊긴 딜러는 회선 기록을 다시 남기지 않는다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

          gateway.handleTournamentClosed({ tournamentId: TOURNAMENT, tableIds: [TABLE], status: 'FINISHED' } as never);
          await gateway.handleDisconnect(dealerClient);

          expect(`기록 ${(gateway as any).lastDealerSeenAt.has(TOURNAMENT)} 유예 ${(gateway as any).graceTimers.size} 멈춤 ${pauses()}`)
            .toBe('기록 false 유예 0 멈춤 0');
        });

        /** 반대 입력 — 한 대라도 답하면 회선은 살아 있다. */
        it('한 대라도 답하고 있으면 안 멈춘다', async () => {
          await seedSyncingTournament(TournamentStatus.ONGOING);
          await seedSeats();
          const quiet = await connect(await dealerTicket(TABLE), TABLE);
          const alive = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
          for (const c of [quiet, alive]) { c.aliveAt = longAgo(); c.ping = jest.fn(); }

          for (let i = 0; i < 4; i++) { await probeOnce(); pong(alive); }

          expect(pauses()).toBe(0);
        });

        /**
         * 침묵한 딜러를 붙어 있는 것으로 세면, 멈추자마자 n/n이 차서 회선이 죽은 채로
         * 대회가 다시 풀린다. 답이 돌아오면 그때 다시 센다.
         */
        it('침묵한 딜러는 n/n에 안 세고, 답이 돌아오면 다시 세어 푼다', async () => {
          await seedSyncingTournament();
          await seedSeats();
          await connectSeats();
          const quiet = await connect(await dealerTicket(TABLE), TABLE);
          quiet.aliveAt = longAgo();
          quiet.ping = jest.fn();
          for (let i = 0; i < 3; i++) await probeOnce();

          const other = await connect(await dealerTicket(OTHER_TABLE), OTHER_TABLE);
          expect(lastSyncingPayload(other)).toEqual({ syncing: true, present: 3, required: 4 });
          expect(`침묵 중 ${recovery.completeSync.mock.calls.length}`).toBe('침묵 중 0');

          pong(quiet);
          await waitUntil(() => recovery.completeSync.mock.calls.length === 1);
          expect(lastSyncingPayload(other)).toEqual({ syncing: false, present: 4, required: 4 });
        });
      });

      it('멈춘 원인을 딜러 띠와 상점 상태에 싣는다', async () => {
        await seedSyncingTournament();
        await seedSeats();
        linePause().markDown(TOURNAMENT);

        const dealerClient = await connect(await dealerTicket(TABLE), TABLE);

        expect(lastSyncingPayload(dealerClient)).toEqual({ syncing: true, present: 1, required: 4, reason: 'lineDown' });
        expect((await gateway.syncStatus(TOURNAMENT)).reason).toBe('lineDown');
      });

      it('대회가 닫히면 원인을 지운다', async () => {
        linePause().markDown(TOURNAMENT);

        gateway.handleTournamentClosed({ tournamentId: TOURNAMENT, tableIds: [TABLE], status: 'COMPLETED' });

        expect(linePause().isDown(TOURNAMENT)).toBe(false);
      });

      /**
       * 진짜 `RecoveryService`로 이음매를 본다. **일부러 끊긴 경우**(딜러 OTP 재발급 등)에는
       * 좌석이 붙어 있다 — 멈춘 스냅샷을 방송하지 않으면 좌석은 낡은 마감 게이지를 계속 그린다.
       */
      it('진짜 RecoveryService로: 멈추면 붙어 있는 좌석이 정지 표시를 받고, 딜러가 돌아오면 풀리며 원인이 지워진다', async () => {
        await seedSyncingTournament(TournamentStatus.ONGOING);
        const session = await prisma.dealerSession.create({ data: { tournamentId: TOURNAMENT } });
        await prisma.table.create({ data: { id: TABLE, tableOrder: 1, tournamentId: TOURNAMENT, dealerId: session.id } });
        const ticket = await seatTicket('alice');
        await prisma.tablePlayer.create({
          data: { tournamentId: TOURNAMENT, tableId: TABLE, userId: 'alice', nickname: 'alice', seatPosition: 0 },
        });
        await new RedisService(redis).rebuildSeatBitmap(TOURNAMENT, TABLE, [0]);
        await redis.set(`table:state:${TABLE}`, JSON.stringify({ ...makeState(), timerEpoch: 3, actionDeadline: Date.now() + 30_000 }));

        const realRecovery = new RecoveryService(prisma as unknown as PrismaService, new RedisService(redis));
        const realGateway = new WsGateway(
          dealer as unknown as DealerService, playsync, new RedisService(redis), tickets,
          new EventEmitter2(), prisma as unknown as PrismaService, realRecovery,
        );
        const open = async (t: string) => {
          const client = makeClient();
          await realGateway.handleConnection(client, makeRequest(`tableId=${TABLE}&ticket=${t}`, ORIGIN));
          return client;
        };
        try {
          const seat = await open(ticket);
          const dealerClient = await open(await dealerTicket(TABLE));
          seat.send.mockClear();

          dealerClient.swept = true;
          await realGateway.handleDisconnect(dealerClient);

          const paused = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
          const frames = seat.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)).filter((m: any) => m.event === 'renderGame');
          expect(`1. 상태 ${paused.status} 좌석이 받은 사유 ${frames.at(-1)?.data.resumePending?.reason} 마감 ${frames.at(-1)?.data.actionDeadline}`)
            .toBe('1. 상태 SYNCING 좌석이 받은 사유 lineDown 마감 undefined');

          await open(await dealerTicket(TABLE));

          const resumed = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
          expect(`2. 상태 ${resumed.status} ${resumed.pausedAt} 원인 ${linePause().isDown(TOURNAMENT)}`)
            .toBe('2. 상태 ONGOING null 원인 false');
        } finally {
          realGateway.onModuleDestroy();
          realRecovery.onModuleDestroy();
        }
      });
    });
  });

  /**
   * Redis 장애(T97). `RecoveryService`는 부팅과 런타임 복구의 실제 전이를
   * 이미 검증한다(`redis/outage.spec.ts` · 시나리오) — 여기서는 **게이트웨이가
   * 상태를 읽고 이벤트에 반응하는가**만 본다. 상태를 바꾸는 방법은 `outage`에
   * 직접 `emit`하고 `phase`를 대입하는 것이다(게이트웨이 계층의 단위 관심사).
   */
  describe('Redis 장애 (T97)', () => {
    function outage() {
      return (gateway as any).redis.outage as import('src/redis/outage').RedisOutage;
    }
    function events(client: { send: jest.Mock }, name: string) {
      return client.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)).filter((m: any) => m.event === name);
    }

    beforeEach(async () => {
      (gateway as any).tableSessions.clear();
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
    });
    afterEach(() => { outage().phase = 'up'; });

    it('down이면 좌석 액션을 즉시 한국어로 거절한다', async () => {
      const seat = await connect(await seatTicket('alice'));
      outage().phase = 'down';
      const res = await gateway.handlePlayerAction(seat, { action: 'CALL' });
      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
    });

    it('recovering이어도 딜러 명령을 거절한다', async () => {
      const d = await connect(await dealerTicket(TABLE));
      outage().phase = 'recovering';
      const res = await gateway.handleDealerAction(d, { action: 'START_PRE_FLOP' });
      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
      expect(dealer.startPreFlop).not.toHaveBeenCalled();
    });

    it('up이면 거절하지 않는다 (반대 입력)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const res = await gateway.handlePlayerAction(seat, { action: 'CALL' });
      expect(res?.data).not.toBe(SERVER_RECOVERING_MESSAGE);
    });

    it('down이면 리바인 응답을 즉시 거절하고 흘려보내지 않는다 (T100)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const emit = jest.spyOn((gateway as any).eventEmitter, 'emit');
      outage().phase = 'down';

      const res = gateway.handleRebuyResponse(seat, { accept: true });

      expect(res).toEqual({ event: 'error', data: SERVER_RECOVERING_MESSAGE });
      expect(emit.mock.calls.some(([name]) => String(name).startsWith('rebuy_res_'))).toBe(false);
      emit.mockRestore();
    });

    it('up이면 리바인 응답을 흘려보낸다 (반대 입력, T100)', async () => {
      const seat = await connect(await seatTicket('alice'));
      const emit = jest.spyOn((gateway as any).eventEmitter, 'emit');

      const res = gateway.handleRebuyResponse(seat, { accept: true });

      expect(res).toBeUndefined();
      expect(emit).toHaveBeenCalledWith('rebuy_res_alice', true);
      emit.mockRestore();
    });

    it('down 이벤트에 테이블 소켓 전원이 down:true를 받는다', async () => {
      const seat = await connect(await seatTicket('alice'));
      const d = await connect(await dealerTicket(TABLE));
      outage().emit('down', Date.now());
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
      expect(events(d, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
    });

    it('recovered 이벤트에 down:false와 renderGame을 받는다', async () => {
      const seat = await connect(await seatTicket('alice'));
      seat.send.mockClear();
      outage().emit('recovered');
      await waitUntil(() => events(seat, 'renderGame').length > 0);
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: false });
      expect(events(seat, 'renderGame').length).toBeGreaterThan(0);
    });

    it('recovering 중에 붙은 소켓은 붙자마자 down:true를 받는다', async () => {
      outage().phase = 'recovering';
      const seat = await connect(await seatTicket('alice'));
      expect(events(seat, SERVER_OUTAGE_EVENT).at(-1)?.data).toEqual({ down: true });
    });

    it('up일 때 붙은 소켓에는 serverOutage를 보내지 않는다 (반대 입력)', async () => {
      const seat = await connect(await seatTicket('alice'));
      expect(events(seat, SERVER_OUTAGE_EVENT)).toHaveLength(0);
    });
  });

  /**
   * 재접속한 좌석의 리바인 팝업 재전송.
   *
   * `REBUY_PROMPT`는 이벤트라, 창이 열린 동안 좌석 소켓이 끊겼다 다시 붙으면
   * 원래 발송을 놓친다. 서버(`PlaysyncService.waitForRebuyResponse`)는 응답
   * 없이 계속 기다리다 15초 마감에 거절로 세고, 그 사람은 `resolveWinners`
   * 3단계에서 탈락한다 — 화면만 못 봤을 뿐 자리는 아직 살아 있는데도.
   */
  describe('재접속한 좌석의 리바인 팝업', () => {
    function outage() {
      return (gateway as any).redis.outage as import('src/redis/outage').RedisOutage;
    }
    function allEvents(client: { send: jest.Mock }) {
      return client.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
    }
    function events(client: { send: jest.Mock }, name: string) {
      return allEvents(client).filter((m: any) => m.event === name);
    }
    function futureDeadline() {
      return Date.now() + 10_000;
    }

    /** 좌석 화면이 보는 스냅샷의 `rebuyPending`을 세운다. */
    async function setState(rebuyPending?: { seatIndexes: number[]; deadline: number }) {
      await redis.set(`table:state:${TABLE}`, JSON.stringify({ ...makeState(), rebuyPending }));
    }

    /** `handleRebuyRequest`를 직접 불러 메모리에 프롬프트를 적어 둔다(진짜 발송 경로). */
    function requestPrompt(deadline = futureDeadline()) {
      gateway.handleRebuyRequest({
        userId: 'alice',
        tableId: TABLE,
        deadline,
        userPoints: 500,
        entryFee: 1000,
        tournamentName: '대회-1',
      });
    }

    afterEach(() => { outage().phase = 'up'; });

    /**
     * **대회가 닫히면 그 테이블의 기록도 버린다**(T101 잔여).
     *
     * 기록은 응답 · 마감 지난 읽기 · 새 프롬프트로만 지워진다. 끝내 다시 안
     * 붙은 사람의 것은 그 셋 중 어느 것도 안 와서 프로세스 재시작까지 남았고,
     * 그 사이 같은 테이블에 다시 붙으면 **끝난 대회의 죽은 프롬프트**를 받는다.
     */
    it('대회가 닫히면 그 테이블의 기록을 버린다 — 다시 붙어도 죽은 프롬프트가 안 온다', async () => {
      const deadline = futureDeadline();
      await setState({ seatIndexes: [0], deadline });
      requestPrompt(deadline);

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [TABLE],
        status: TournamentStatus.CANCELLED,
      });

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    /** **반대 입력** — 다른 테이블이 닫혀도 내 기록은 남는다. */
    it('다른 테이블의 닫힘으로는 기록이 안 지워진다', async () => {
      const deadline = futureDeadline();
      await setState({ seatIndexes: [0], deadline });
      requestPrompt(deadline);

      gateway.handleTournamentClosed({
        tournamentId: TOURNAMENT,
        tableIds: [OTHER_TABLE],
        status: TournamentStatus.CANCELLED,
      });

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(1);
    });

    it('대기 중(rebuyPending에 내 자리·마감 미래) 붙으면 renderGame 다음에 REBUY_PROMPT를 받는다', async () => {
      const deadline = futureDeadline();
      await setState({ seatIndexes: [0], deadline });
      requestPrompt(deadline);

      const seat = await connect(await seatTicket('alice'));

      const names = allEvents(seat).map((m: any) => m.event);
      const renderIdx = names.indexOf('renderGame');
      const promptIdx = names.indexOf('REBUY_PROMPT');
      expect(renderIdx).toBeGreaterThanOrEqual(0);
      expect(promptIdx).toBeGreaterThan(renderIdx);
      expect(events(seat, 'REBUY_PROMPT').at(-1)?.data).toEqual({
        deadline,
        userPoints: 500,
        entryFee: 1000,
        tournamentName: '대회-1',
      });
    });

    it('같은 유저의 소켓이 둘 붙어 있으면 (좀비 포함) 모두에게 보낸다 (I1)', async () => {
      // 소켓이 끊기지 않은 채(sendToTableUser가 첫 소켓에서 멈추면 이 사실을
      // 놓친다) 재접속한 상황을 재현한다 — Wi-Fi 순단으로 옛 소켓이 keepalive
      // 스윕 전까지 OPEN으로 남아 있는 것과 같은 모양이다.
      const zombie = await connect(await seatTicket('alice'));
      const fresh = await connect(await seatTicket('alice'));
      zombie.send.mockClear();
      fresh.send.mockClear();

      requestPrompt();

      expect(events(zombie, 'REBUY_PROMPT')).toHaveLength(1);
      expect(events(fresh, 'REBUY_PROMPT')).toHaveLength(1);
    });

    it('반대 입력: rebuyPending이 없으면 안 받는다', async () => {
      await setState(undefined);
      requestPrompt();

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('반대 입력: rebuyPending이 다른 자리만 실으면 안 받는다', async () => {
      await setState({ seatIndexes: [1], deadline: futureDeadline() });
      requestPrompt();

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('반대 입력: 마감이 지났으면 안 받는다', async () => {
      await setState({ seatIndexes: [0], deadline: futureDeadline() });
      requestPrompt(Date.now() - 1000);

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('응답을 보낸 뒤 다시 붙으면 안 받는다', async () => {
      await setState({ seatIndexes: [0], deadline: futureDeadline() });
      requestPrompt();
      const first = await connect(await seatTicket('alice'));
      gateway.handleRebuyResponse(first, { accept: true });

      const second = await connect(await seatTicket('alice'));

      expect(events(second, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('장애 중에 붙으면 안 받는다', async () => {
      await setState({ seatIndexes: [0], deadline: futureDeadline() });
      requestPrompt();
      outage().phase = 'down';

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('복구와 정리 사이의 낡은 프롬프트는 세대가 바뀌면 안 받는다 (최종 리뷰 M2)', async () => {
      // markRecovered ~ markRebuyInterrupted의 쓰기 사이를 흉내낸다: 스냅샷은
      // 아직 이 사람을 기다리는 rebuyPending·미래 마감을 이지만, 장애가 한 번
      // 났다 간 뒤라 이 기록의 세대는 낡았다.
      await setState({ seatIndexes: [0], deadline: futureDeadline() });
      requestPrompt();
      const before = outage().generation;
      outage().generation += 1;
      try {
        const seat = await connect(await seatTicket('alice'));

        expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
      } finally {
        outage().generation = before;
      }
    });

    it('반대 입력: 지난 라운드의 낡은 프롬프트는 새 마커보다 이르면 안 받는다 (M1)', async () => {
      // `markRebuyPending`이 이번 라운드의 마감을 이미 세운 뒤인데, 적어 둔
      // 프롬프트는 그보다 5초 이른 — 장애로 끊긴 이전 라운드의 것이다.
      const staleDeadline = futureDeadline();
      await setState({ seatIndexes: [0], deadline: staleDeadline + 5000 });
      requestPrompt(staleDeadline);

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(0);
    });

    it('자리는 배열 위치로 맞춘다 — seatIndex 필드가 배열 위치와 달라도 받는다 (M2)', async () => {
      // alice는 `players` 배열의 1번 자리(= markRebuyPending이 seatIndexes를
      // 지을 때 쓰는 좌표)에 있지만, TablePlayer.seatIndex 필드는 3이다.
      // 둘이 같다는 보장이 없다는 것을 보이는 입력이다.
      const players = [makePlayer('bob', 5), { ...makePlayer('alice', 0), seatIndex: 3 }];
      await redis.set(`table:state:${TABLE}`, JSON.stringify({
        ...makeState(), players, rebuyPending: { seatIndexes: [1], deadline: futureDeadline() },
      }));
      requestPrompt();

      const seat = await connect(await seatTicket('alice'));

      expect(events(seat, 'REBUY_PROMPT')).toHaveLength(1);
    });
  });

  describe('좌석 세대 재대조(T110)', () => {
    /** 참가 행의 세대를 `rowVersion`으로 세우고, 티켓에 실은 값으로 붙는다. */
    async function connectSeat(
      rowVersion: number,
      ticket: { seatTokenVersion?: number; tournamentId?: string },
    ) {
      await ensureParticipation('alice', TOURNAMENT, rowVersion);
      const t = await tickets.issue({ sub: 'alice', role: SEAT_ROLE, ...ticket });
      return connect(t);
    }

    it('티켓의 세대가 참가 행과 같으면 붙는다', async () => {
      const client = await connectSeat(3, { tournamentId: TOURNAMENT, seatTokenVersion: 3 });
      expect(client.close).not.toHaveBeenCalled();
    });

    it('티켓 발급 뒤 세대가 오르면 접속에서 거절한다', async () => {
      const client = await connectSeat(3, { tournamentId: TOURNAMENT, seatTokenVersion: 2 });
      expect(client.close).toHaveBeenCalledWith(4001, '만료된 좌석입니다. OTP를 다시 입력해 주세요.');
    });

    it('세대가 없는 좌석 티켓은 거절한다', async () => {
      const client = await connectSeat(0, { tournamentId: TOURNAMENT });
      expect(client.close).toHaveBeenCalledWith(4001, '만료된 좌석입니다. OTP를 다시 입력해 주세요.');
    });

    it('방에 들어가는 사이 세대가 오르면 4001로 닫고 방에서 뺀다', async () => {
      // 대조와 addToMap 사이에 터진 SEAT_TOKENS_REVOKED는 아직 방에 없는 소켓을
      // 놓친다. 접근 판정이 끝나는 순간에 세대를 올려 그 틈을 만든다.
      await ensureParticipation('alice', TOURNAMENT, 3);
      const real = playsync.assertTableAccess.bind(playsync);
      jest.spyOn(playsync, 'assertTableAccess').mockImplementationOnce(async (...args) => {
        await real(...args);
        await prisma.tournamentParticipation.update({
          where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'alice' } },
          data: { seatTokenVersion: 4 },
        });
      });
      const t = await tickets.issue({
        sub: 'alice', role: SEAT_ROLE, tournamentId: TOURNAMENT, seatTokenVersion: 3,
      });

      const client = await connect(t);

      expect(client.close).toHaveBeenCalledWith(4001, expect.any(String));
      expect([...((gateway as any).tableSessions.get(TABLE) ?? [])]).not.toContain(client);
    });

    it('두 번째 대조가 낡음이 아닌 오류로 실패하면 1008로 닫고 방에서 뺀다 — 재시도 가능', async () => {
      await ensureParticipation('alice', TOURNAMENT, 3);
      const real = playsync.assertTableAccess.bind(playsync);
      // 첫 대조는 이미 지났다. 접근 판정이 끝나는 순간 DB가 죽는다.
      jest.spyOn(playsync, 'assertTableAccess').mockImplementationOnce(async (...args) => {
        await real(...args);
        jest.spyOn(prisma.tournamentParticipation, 'findMany').mockRejectedValueOnce(new Error('db down'));
      });
      const t = await tickets.issue({
        sub: 'alice', role: SEAT_ROLE, tournamentId: TOURNAMENT, seatTokenVersion: 3,
      });

      const client = await connect(t);

      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
      expect(client.close).not.toHaveBeenCalledWith(4001, expect.anything());
      expect([...((gateway as any).tableSessions.get(TABLE) ?? [])]).not.toContain(client);
    });
  });

  describe('닫히는 소켓의 수신(T110)', () => {
    // 해제로 close()된 소켓은 CLOSING(2)이지만 피어가 응답할 때까지 프레임이 계속 들어온다.
    it('CLOSING 소켓의 딜러 명령은 실행하지 않는다', async () => {
      const client = await connect(await dealerTicket(TABLE));
      client.readyState = 2;
      const res = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });
      expect(res).toBeUndefined();
      expect(dealer.startPreFlop).not.toHaveBeenCalled();
    });

    it('CLOSING 소켓의 좌석 액션은 실행하지 않는다', async () => {
      const client = await connect(await playerTicket('alice'));
      client.readyState = 2;
      const res = await gateway.handlePlayerAction(client, { action: 'FOLD' });
      expect(res).toBeUndefined();
      expect(playsync.handleAction).not.toHaveBeenCalled();
    });

    it('CLOSING 소켓의 리바인 응답은 흘려보내지 않는다', async () => {
      const client = await connect(await seatTicket('alice'));
      client.readyState = 2;
      const emit = jest.spyOn((gateway as any).eventEmitter, 'emit');
      gateway.handleRebuyResponse(client, { accept: true });
      expect(emit.mock.calls.some(([name]) => String(name).startsWith('rebuy_res_'))).toBe(false);
      emit.mockRestore();
    });
  });

  describe('@OnEvent 배선(T110)', () => {
    const eventsOf = (name: 'handleSeatTokensRevoked' | 'handleDealerSessionRevoked') =>
      (Reflect.getMetadata(EVENT_LISTENER_METADATA, WsGateway.prototype[name]) as { event: string }[]).map((m) => m.event);

    it('좌석·딜러 폐기 핸들러는 서비스가 내는 이벤트 이름을 듣는다', () => {
      expect(eventsOf('handleSeatTokensRevoked')).toEqual(['SEAT_TOKENS_REVOKED']);
      expect(eventsOf('handleDealerSessionRevoked')).toEqual(['DEALER_SESSION_REVOKED']);
    });
  });

  describe('딜러 폐기(T110)', () => {
    it('DEALER_SESSION_REVOKED는 그 대회의 딜러 소켓만 4001로 닫는다', async () => {
      const dealerSocket = async (tournamentId: string) => {
        const t = await tickets.issue({
          sub: 'dealer-' + tournamentId, role: Role.DEALER, tournamentId, tableId: TABLE, tokenVersion: 0,
        });
        const client = await connect(t);
        expect(client.close).not.toHaveBeenCalled();
        return client;
      };
      const dealerA = await dealerSocket('A');
      const dealerB = await dealerSocket('B');
      await ensureParticipation('u1', 'A', 0);
      const seatA = makeClient();
      await gateway.handleConnection(seatA, makeRequest(
        `tournamentId=A&ticket=${await tickets.issue({ sub: 'u1', role: SEAT_ROLE, tournamentId: 'A', seatTokenVersion: 0 })}`,
        ORIGIN,
      ));
      expect(seatA.close).not.toHaveBeenCalled();

      gateway.handleDealerSessionRevoked({ tournamentId: 'A' });

      expect(dealerA.close).toHaveBeenCalledWith(4001, DEALER_REVOKED_REASON);
      for (const other of [dealerB, seatA]) expect(other.close).not.toHaveBeenCalled();
    });

    const dealerTicketV0 = () => tickets.issue({
      sub: 'dealer-session-1', role: Role.DEALER, tournamentId: TOURNAMENT, tableId: TABLE, tokenVersion: 0,
    });

    it('딜러 티켓도 접속에서 세션을 다시 본다 — 30초 창에 내보내졌으면 4001로 거절', async () => {
      dealer.assertDealerSessionValid.mockRejectedValueOnce(new ForbiddenException('만료된 딜러 세션입니다.'));
      const client = await connect(await dealerTicketV0());
      expect(client.close).toHaveBeenCalledWith(4001, '만료된 딜러 세션입니다.');
    });

    it('이른 대조가 낡음이 아닌 오류로 실패하면 1008 — 재시도 가능', async () => {
      dealer.assertDealerSessionValid.mockRejectedValueOnce(new Error('db down'));
      const client = await connect(await dealerTicketV0());
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
      expect(client.close).not.toHaveBeenCalledWith(4001, expect.anything());
    });

    it('방에 들어가는 사이 내보내지면 4001로 닫고 방에서 뺀다', async () => {
      const real = playsync.assertTableAccess.bind(playsync);
      jest.spyOn(playsync, 'assertTableAccess').mockImplementationOnce(async (...args) => {
        await real(...args);
        dealer.assertDealerSessionValid.mockRejectedValueOnce(new ForbiddenException('만료된 딜러 세션입니다.'));
      });

      const client = await connect(await dealerTicketV0());

      expect(client.close).toHaveBeenCalledWith(4001, '만료된 딜러 세션입니다.');
      expect([...((gateway as any).tableSessions.get(TABLE) ?? [])]).not.toContain(client);
    });
  });

  describe('SEAT_TOKENS_REVOKED(T110)', () => {
    const REASON = '다른 기기에서 이 좌석에 다시 들어왔습니다.';

    it('그 대회 · 그 사람 · 좌석 역할의 소켓만 4001로 닫는다', async () => {
      const state = makeState();
      state.players = [makePlayer('u1', 0), makePlayer('u2', 1)];
      await redis.set(`table:state:${TABLE}`, JSON.stringify(state));

      const seatSocket = async (userId: string, tournamentId: string, tableId?: string) => {
        await ensureParticipation(userId, tournamentId, 0);
        const ticket = await tickets.issue({
          sub: userId, role: SEAT_ROLE, tournamentId, seatTokenVersion: 0,
        });
        const client = makeClient();
        const query = tableId ? `tableId=${tableId}` : `tournamentId=${tournamentId}`;
        await gateway.handleConnection(client, makeRequest(`${query}&ticket=${ticket}`, ORIGIN));
        expect(client.close).not.toHaveBeenCalled();
        return client;
      };

      const u1TableA = await seatSocket('u1', 'A', TABLE);
      const u1RoomA = await seatSocket('u1', 'A');
      const u2A = await seatSocket('u2', 'A', TABLE);
      // 같은 사람의 다른 대회. 좌석 소켓이 대회를 가르는지 본다.
      const u1B = await seatSocket('u1', 'B');
      // 같은 사람의 USER 폰. 대회 방에 붙지만 좌석 역할이 아니다.
      const phone = makeClient();
      await gateway.handleConnection(
        phone,
        makeRequest(`tournamentId=A&ticket=${await playerTicket('u1')}`, ORIGIN),
      );
      expect(phone.close).not.toHaveBeenCalled();

      gateway.handleSeatTokensRevoked({ tournamentId: 'A', userIds: ['u1'], reason: REASON });

      expect(u1TableA.close).toHaveBeenCalledWith(4001, REASON);
      expect(u1RoomA.close).toHaveBeenCalledWith(4001, REASON);
      for (const other of [u2A, u1B, phone]) expect(other.close).not.toHaveBeenCalled();
    });
  });
});
