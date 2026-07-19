import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AuthService } from 'src/auth/auth.service';
import { DealerService } from 'src/dealer/dealer.service';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PaymentService } from 'src/payment/payment.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import { WsGateway } from 'src/ws/ws.gateway';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 사람이 실제로 하는 순서 그대로, 처음부터 끝까지.
 *
 * 기존 시나리오들은 **착석한 뒤부터**를 본다. 서비스를 직접 부르고 토큰은
 * `{} as JwtService`로 비워 뒀다. 검증 대상이 게임 진행이었으니 옳은 선택이었다.
 *
 * 여기는 그 앞뒤를 잇는다. 회원가입 → 로그인 → 좌석 결제 → 딜러 OTP →
 * **WS 접속** → 핸드 → 상금 → 관리자 마무리. 스텁이 하나도 없고, 게임 명령은
 * 서비스가 아니라 **게이트웨이를 통과해서** 들어간다. 실제로 명령이 들어오는
 * 유일한 문이 거기이기 때문이다.
 *
 * 이 계층이 잡는 것은 부품의 버그가 아니라 **이음매의 버그**다. T16이
 * 그랬다 — 두 함수가 각각 옳은데 순서만 틀렸다.
 *
 * 가장 중요한 검사는 마지막 하나다. **참가 전 포인트 총합 == 종료 후 총합.**
 * 참가비로 걷은 것이 상금으로 전부 돌아왔다는 뜻이고, 이게 어긋나면 나머지가
 * 다 맞아도 소용없다. T19가 고친 것이 정확히 이 구멍이었다 — 상금이 참가자
 * 행에 숫자로만 적히고 포인트는 그대로였다.
 */
describe('시나리오 — 회원가입부터 대회 마무리까지', () => {
  const SECRET = 'test-only-not-a-real-secret';
  const ENTRY_FEE = 10000;
  const START_STACK = 30000;
  const INITIAL_POINTS = 50000;

  const PLAYERS = ['alice', 'bob', 'carol'];
  const PAYOUTS = [
    { place: 1, percent: 70 },
    { place: 2, percent: 30 },
  ];

  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let prisma: PrismaClient;

  let auth: AuthService;
  let userService: UserService;
  let payment: PaymentService;
  let session: SessionService;
  let dealer: DealerService;
  let playsync: PlaysyncService;
  let redisService: RedisService;
  let gateway: WsGateway;
  let jwt: JwtService;

  /** 로그인해서 받은 진짜 토큰. 좌석 태블릿이 들고 있는 것과 같다. */
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let dealerToken: string;

  let tournamentId: string;
  let tableId: string;
  let storeId: string;

  // ── 가짜 소켓 ────────────────────────────────────────────
  // 진짜인 것은 게이트웨이·서비스·DB·Redis다. 소켓은 전송 계층이라
  // ws 서버를 띄우지 않는다 — 검증 대상이 전송이 아니라 권한과 진행이다.

  function makeClient() {
    const client: any = {
      sent: [] as { event: string; data: unknown }[],
      readyState: 1,
      close: jest.fn(),
      send: jest.fn((raw: string) => client.sent.push(JSON.parse(raw))),
    };
    return client;
  }

  async function connect(token: string) {
    const client = makeClient();
    await gateway.handleConnection(client, {
      url: `/playsync?tableId=${tableId}&token=${token}`,
      headers: { host: 'localhost' },
    });
    return client;
  }

  async function snapshot(): Promise<TableState> {
    const raw = await redis.get(`table:state:${tableId}`);
    if (!raw) throw new Error('스냅샷이 없다');
    return JSON.parse(raw) as TableState;
  }

  async function pointsOf(nickname: string) {
    return (await prisma.user.findUniqueOrThrow({
      where: { id: userIds[nickname] },
    })).points;
  }

  async function totalPoints() {
    const users = await prisma.user.findMany({
      where: { id: { in: Object.values(userIds) } },
    });
    return users.reduce((sum, u) => sum + u.points, 0);
  }

  function seatOf(state: TableState, nickname: string) {
    return state.players.findIndex(p => p?.id === userIds[nickname]);
  }

  function turnNickname(state: TableState): string | null {
    if (state.currentTurnSeatIndex === -1) return null;
    const id = state.players[state.currentTurnSeatIndex]?.id;
    return PLAYERS.find(n => userIds[n] === id) ?? null;
  }

  beforeAll(async () => {
    redis = createTestRedis();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });
    prisma = createTestPrisma();

    await truncateAll(prisma);
    await flushTestRedis(redis);

    const prismaService = prisma as unknown as PrismaService;
    const emitter = new EventEmitter2();
    jwt = new JwtService({ secret: SECRET });

    redisService = new RedisService(redis);
    userService = new UserService(prismaService);
    auth = new AuthService(prismaService, userService, jwt);
    playsync = new PlaysyncService(queue, redisService, prismaService, emitter);
    session = new SessionService(prismaService, redisService);
    payment = new PaymentService(userService, session, prismaService, redisService, emitter);
    dealer = new DealerService(queue, prismaService, redisService, playsync, jwt);
    gateway = new WsGateway(dealer, playsync, redisService, jwt, emitter);

    // 세 명으로 진행한다. 운영 기본값은 6이고 그 규칙은 T16이 따로 검증한다.
    process.env.MIN_PLAYERS_TO_START = '3';
  });

  afterAll(async () => {
    delete process.env.MIN_PLAYERS_TO_START;
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  it('1. 회원가입하면 비밀번호가 평문으로 남지 않는다', async () => {
    for (const nickname of PLAYERS) {
      await auth.createUser({ nickname, password: 'pw-' + nickname } as never);
    }
    await auth.createStoreAdmin({ nickname: 'owner', password: 'pw-owner' } as never);

    const alice = await prisma.user.findUniqueOrThrow({ where: { nickname: 'alice' } });
    expect(alice.password).not.toBe('pw-alice');
    expect(alice.role).toBe('USER');

    const owner = await prisma.user.findUniqueOrThrow({ where: { nickname: 'owner' } });
    expect(owner.role).toBe('STORE_ADMIN');
  });

  it('2. 같은 닉네임으로 또 가입할 수 없다', async () => {
    await expect(
      auth.createUser({ nickname: 'alice', password: 'other' } as never),
    ).rejects.toThrow(/이미 존재하는/);
  });

  it('3. 로그인하면 토큰을 받는다', async () => {
    for (const nickname of PLAYERS) {
      const { accessToken } = await auth.login({ nickname, password: 'pw-' + nickname } as never);
      tokens[nickname] = accessToken;

      // 토큰 안의 sub가 곧 유저 id다. 이후 모든 경로가 이 값으로 사람을 가린다.
      const payload = jwt.verify(accessToken) as { sub: string };
      userIds[nickname] = payload.sub;
    }
    const owner = await auth.login({ nickname: 'owner', password: 'pw-owner' } as never);
    userIds.owner = (jwt.verify(owner.accessToken) as { sub: string }).sub;

    expect(Object.keys(userIds)).toHaveLength(PLAYERS.length + 1);
  });

  it('4. 틀린 비밀번호는 거부한다', async () => {
    await expect(
      auth.login({ nickname: 'alice', password: '틀린비번' } as never),
    ).rejects.toThrow(/비밀번호나 닉네임/);
  });

  it('5. 참가비를 낼 포인트를 충전한다', async () => {
    // 임시 충전 경로다. 실제 결제 연동은 이 프로젝트 밖이다.
    for (const nickname of PLAYERS) {
      for (let i = 0; i < INITIAL_POINTS / 10000; i++) {
        await userService.addPoint(userIds[nickname]);
      }
    }

    expect(await pointsOf('alice')).toBe(INITIAL_POINTS);
  });

  it('6. 상점 관리자가 대회를 연다', async () => {
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId: userIds.owner },
    });
    storeId = store.id;

    const blind = await prisma.blindStructure.create({
      data: {
        name: '기본 구조', storeId,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 60 }],
      },
    });

    await session.createSession({
      name: '전체 플로우 대회',
      type: 'TOURNAMENT',
      storeId,
      startStack: START_STACK,
      entryFee: ENTRY_FEE,
      rebuyUntil: 5,
      prizePayouts: PAYOUTS,
      isRegistrationOpen: true,
      blindId: blind.id,
    } as never);

    const created = await prisma.tournament.findFirstOrThrow({ where: { storeId } });
    tournamentId = created.id;
    tableId = (await prisma.table.findFirstOrThrow({
      where: { tournamentId },
    })).id;

    // itmCount는 분배율에서 파생된다 (T18).
    expect(created.itmCount).toBe(PAYOUTS.length);
    expect(created.status).toBe('PENDING');
  });

  it('7. 참가자가 좌석을 고르면 포인트가 빠지고 내역이 남는다', async () => {
    for (const [seat, nickname] of PLAYERS.entries()) {
      await payment.joinSessionWithSeat(
        { tournamentId, tableId, seatIndex: seat }, userIds[nickname],
      );
    }

    expect(await pointsOf('alice')).toBe(INITIAL_POINTS - ENTRY_FEE);

    const buyIn = await prisma.pointTransaction.findFirstOrThrow({
      where: { userId: userIds.alice, type: 'BUY_IN' },
    });
    expect(buyIn.amount).toBe(-ENTRY_FEE);

    // 걷은 참가비가 곧 프라이즈풀이다.
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.totalBuyinAmount).toBe(ENTRY_FEE * PLAYERS.length);
  });

  it('8. 포인트가 모자라면 앉을 수 없다', async () => {
    await auth.createUser({ nickname: 'poor', password: 'pw' } as never);
    const poor = await prisma.user.findUniqueOrThrow({ where: { nickname: 'poor' } });

    await expect(
      payment.joinSessionWithSeat(
        { tournamentId, tableId, seatIndex: 5 }, poor.id,
      ),
    ).rejects.toThrow(/포인트가 부족/);
  });

  it('9. 대회를 시작하면 DB와 Redis가 함께 준비된다', async () => {
    await session.startSession(tournamentId);

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.status).toBe('ONGOING');
    expect(t.startedAt).not.toBeNull();

    // T16. Redis가 준비된 뒤에 DB를 커밋한다. 스냅샷이 없으면 시작 자체가
    // 실패해야 하고, DB만 진행 중으로 남는 상태가 없어야 한다.
    const state = await snapshot();
    expect(state.players.filter(p => p !== null)).toHaveLength(PLAYERS.length);
    expect(state.phase).toBe(GamePhase.WAITING);
  });

  it('10. 딜러가 OTP로 로그인해 토큰을 받는다', async () => {
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });

    const { accessToken } = await dealer.loginDealer({
      tournamentId, tableId, otp: t.dealerOtp,
    } as never);
    dealerToken = accessToken;

    const payload = jwt.verify(accessToken) as { role: string; tableId: string };
    expect(payload.role).toBe('DEALER');
    // 토큰에 테이블이 박힌다. 게이트웨이가 쿼리의 tableId와 대조한다.
    expect(payload.tableId).toBe(tableId);
  });

  it('11. 틀린 OTP는 거부한다', async () => {
    await expect(
      dealer.loginDealer({ tournamentId, tableId, otp: 9999 } as never),
    ).rejects.toThrow(/인증 정보/);
  });

  it('12. 참가자와 딜러가 WS에 붙는다', async () => {
    const client = await connect(tokens.alice);
    expect(client.close).not.toHaveBeenCalled();

    const dealerClient = await connect(dealerToken);
    expect(dealerClient.close).not.toHaveBeenCalled();
  });

  it('13. 좌석이 없는 사람은 붙을 수 없다', async () => {
    // 태블릿은 버튼만 있지만 그건 UI의 제약이다. 같은 망의 아무 단말이나
    // 이 엔드포인트를 직접 열 수 있다.
    const poor = await prisma.user.findUniqueOrThrow({ where: { nickname: 'poor' } });
    const outsider = jwt.sign({ sub: poor.id, nickname: 'poor', role: 'USER' });

    const client = await connect(outsider);
    expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('14. 딜러가 WS로 핸드를 연다', async () => {
    // **여기부터 게임 명령은 전부 게이트웨이를 통과한다.**
    const dealerClient = await connect(dealerToken);

    const result = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

    expect(result).toBeUndefined(); // 성공하면 에러를 돌려주지 않는다
    const state = await snapshot();
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(state.smallBlind).toBe(100);
  });

  it('15. 참가자가 WS로 액션을 보내면 테이블 전원이 상태를 받는다', async () => {
    const state = await snapshot();
    const actor = turnNickname(state)!;

    const clients = await Promise.all(PLAYERS.map(n => connect(tokens[n])));
    const actorClient = clients[PLAYERS.indexOf(actor)];

    await gateway.handlePlayerAction(actorClient, { action: 'CALL' });

    // 브로드캐스트가 이 테이블 전원에게 간다.
    for (const client of clients) {
      const rendered = client.sent.filter((m: any) => m.event === 'renderGame');
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  it('16. 남의 차례에 보낸 액션은 상태를 바꾸지 못한다', async () => {
    const before = await snapshot();
    const actor = turnNickname(before)!;
    const other = PLAYERS.find(n => n !== actor)!;

    const client = await connect(tokens[other]);
    await gateway.handlePlayerAction(client, { action: 'FOLD' });

    const after = await snapshot();
    expect(turnNickname(after)).toBe(actor);
    expect(after.players[seatOf(after, other)]!.hasFolded).toBe(false);
  });

  it('17. 딜러 명령을 참가자 토큰으로는 보낼 수 없다', async () => {
    const client = await connect(tokens.alice);

    const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

    expect(result?.event).toBe('error');
  });

  it('18. 핸드가 쇼다운까지 간다', async () => {
    for (let guard = 0; guard < 40; guard++) {
      const state = await snapshot();
      if (state.phase >= GamePhase.SHOWDOWN) break;

      const actor = turnNickname(state);
      if (!actor) break;
      const me = state.players[seatOf(state, actor)]!;
      const action = me.bet === state.currentBet ? 'CHECK' : 'CALL';

      const client = await connect(tokens[actor]);
      await gateway.handlePlayerAction(client, { action });
    }

    const state = await snapshot();
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    // 쇼다운에는 차례가 없다. 있으면 딜러가 승자를 넣는 동안 남의 태블릿에
    // 카운트다운이 돈다 (T17이 잡은 것).
    expect(state.currentTurnSeatIndex).toBe(-1);
  });

  it('19. 딜러가 WS로 승자를 지명하면 팟이 나간다', async () => {
    const before = await snapshot();
    const pot = before.pot;
    const winner = PLAYERS[0];
    const stackBefore = before.players[seatOf(before, winner)]!.stack;

    const dealerClient = await connect(dealerToken);
    await gateway.handleDealerAction(dealerClient, {
      action: 'RESOLVE_WINNERS',
      winnerGroups: [[userIds[winner]]],
    });

    const after = await snapshot();
    expect(after.players[seatOf(after, winner)]!.stack).toBe(stackBefore + pot);
    expect(after.pot).toBe(0);
  });

  it('20. 칩 총량은 처음부터 끝까지 보존된다', async () => {
    const state = await snapshot();
    const onTable =
      state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;

    expect(onTable).toBe(START_STACK * PLAYERS.length);
  });

  it('21. 정산이 안 끝났으면 대회를 닫을 수 없다', async () => {
    // T19. 닫으면 테이블·딜러 세션·Redis가 지워져 재구성할 근거가 사라진다.
    await expect(session.completeSession(tournamentId)).rejects.toThrow(/정산이 끝나지 않았/);
  });

  it('22. 사람이 줄어들면 상금이 포인트로 들어온다', async () => {
    // 등록을 닫아 리바인 없이 곧바로 탈락하게 한다.
    await prisma.tournament.update({
      where: { id: tournamentId }, data: { isRegistrationOpen: false },
    });
    await redis.hset(`tournament:${tournamentId}:info`, 'isRegistrationOpen', '0');

    const pool = ENTRY_FEE * PLAYERS.length;

    // 3위 → 상금권 밖, 2위 → 30%, 남은 1인 → 70%.
    for (const victim of [PLAYERS[2], PLAYERS[1]]) {
      await bustOut(victim);
    }

    expect(await pointsOf(PLAYERS[1])).toBe(INITIAL_POINTS - ENTRY_FEE + pool * 0.3);
    expect(await pointsOf(PLAYERS[0])).toBe(INITIAL_POINTS - ENTRY_FEE + pool * 0.7);

    const prizeRows = await prisma.pointTransaction.findMany({ where: { type: 'PRIZE' } });
    expect(prizeRows).toHaveLength(2);
  });

  it('23. 정산이 끝나면 대회가 닫히고 캐시가 정리된다', async () => {
    await session.completeSession(tournamentId);

    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    expect(t.status).toBe('FINISHED');
    expect(t.finishedAt).not.toBeNull();

    // Redis가 남아 있으면 끝난 대회의 상태를 누가 계속 읽는다.
    expect(await redis.get(`table:state:${tableId}`)).toBeNull();
    expect(await redis.exists(`tournament:${tournamentId}:info`)).toBe(0);

    // 테이블과 딜러 세션도 사라진다 — 딜러 토큰이 가리킬 곳이 없다.
    expect(await prisma.table.count({ where: { tournamentId } })).toBe(0);
  });

  it('24. 나간 포인트가 전부 돌아왔다', async () => {
    // **이 시나리오의 결론.** 참가비로 걷은 것이 상금으로 전부 나갔다면 대회
    // 하나의 회계가 맞아떨어진 것이다. 한쪽만 도는 동안은 아무도 눈치채지
    // 못한다 — T19 이전이 정확히 그 상태였다.
    const expected = INITIAL_POINTS * PLAYERS.length;

    expect(`총 포인트 ${await totalPoints()}`).toBe(`총 포인트 ${expected}`);
  });

  it('25. 참가 기록은 남는다', async () => {
    // 캐시는 지우지만 대회 기록은 영구 데이터다. 누가 몇 등으로 얼마를
    // 받았는지가 남아야 정산 근거가 된다.
    const rows = await prisma.tournamentParticipation.findMany({
      where: { tournamentId }, orderBy: { finalPlace: 'asc' },
    });

    expect(rows).toHaveLength(PLAYERS.length);
    expect(rows.map(r => r.finalPlace)).toEqual([1, 2, 3]);
    expect(rows.reduce((sum, r) => sum + r.prizeAmount, 0))
      .toBe(ENTRY_FEE * PLAYERS.length);
  });

  // ── 도우미 ────────────────────────────────────────────────

  /** 지정한 사람이 탈락할 때까지 핸드를 돌린다. 전부 WS를 통과한다. */
  async function bustOut(victim: string) {
    for (let hand = 0; hand < 12; hand++) {
      const row = await prisma.tournamentParticipation.findFirstOrThrow({
        where: { tournamentId, userId: userIds[victim] },
      });
      if (row.status !== 'PLAYING') return;

      await finishHand();

      // 희생자만 짧게 만든다. 실제 대회에서도 스택이 줄어든 사람이 밀린다.
      const before = await snapshot();
      const total = before.players.reduce((s, p) => s + (p?.stack ?? 0), 0);
      const others = before.players.filter(p => p && p.id !== userIds[victim]).length;
      for (const p of before.players) {
        if (!p) continue;
        p.stack = p.id === userIds[victim] ? 500 : Math.floor((total - 500) / others);
      }
      await redis.set(`table:state:${tableId}`, JSON.stringify(before));

      const dealerClient = await connect(dealerToken);
      await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      for (let guard = 0; guard < 20; guard++) {
        const state = await snapshot();
        if (state.phase >= GamePhase.SHOWDOWN) break;
        const actor = turnNickname(state);
        if (!actor) break;

        const me = state.players[seatOf(state, actor)]!;
        const target = Math.min(me.stack + me.bet, 500);
        const client = await connect(tokens[actor]);
        if (target > state.currentBet) {
          await gateway.handlePlayerAction(client, { action: 'RAISE', amount: target });
        } else {
          await gateway.handlePlayerAction(client, { action: 'CALL' });
        }
      }

      const state = await snapshot();
      if (state.phase !== GamePhase.SHOWDOWN) continue;

      const winners = state.players
        .filter(p => p && !p.hasFolded && p.id !== userIds[victim])
        .map(p => p!.id);
      if (winners.length === 0) continue;

      await gateway.handleDealerAction(dealerClient, {
        action: 'RESOLVE_WINNERS',
        winnerGroups: [winners.slice(0, 1)],
      });
    }

    throw new Error(`${victim}을(를) 탈락시키지 못했다`);
  }

  /** 진행 중인 핸드를 끝내고 WAITING까지 되돌린다. */
  async function finishHand() {
    for (let guard = 0; guard < 40; guard++) {
      const state = await snapshot();
      if (state.phase === GamePhase.WAITING) return;

      if (state.phase === GamePhase.SHOWDOWN) {
        const alive = state.players.filter(p => p && !p.hasFolded).map(p => p!.id);
        const dealerClient = await connect(dealerToken);
        await gateway.handleDealerAction(dealerClient, {
          action: 'RESOLVE_WINNERS',
          winnerGroups: [alive.slice(0, 1)],
        });
        continue;
      }

      const actor = turnNickname(state);
      if (!actor) throw new Error(`핸드를 끝내지 못했다: phase=${GamePhase[state.phase]}`);
      const me = state.players[seatOf(state, actor)]!;
      const action = me.bet === state.currentBet ? 'CHECK' : 'CALL';
      const client = await connect(tokens[actor]);
      await gateway.handlePlayerAction(client, { action });
    }

    const state = await snapshot();
    throw new Error(`핸드가 끝나지 않았다: phase=${GamePhase[state.phase]}`);
  }
});
