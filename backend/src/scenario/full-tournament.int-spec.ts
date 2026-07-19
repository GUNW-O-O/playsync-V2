import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from 'src/dealer/dealer.service';
import { ActionType, GamePhase, TableState } from 'src/game-engine/types';
import { PaymentService } from 'src/payment/payment.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 대회 하나를 처음부터 끝까지 실제로 돌린다.
 *
 * **왜 이 계층이 필요한가.** 지금까지의 테스트는 전부 이음매 하나씩만 본다 —
 * 락 하나, 트랜잭션 하나, 스키마 경계 하나. 그런데 T16에서 드러난 버그는
 * `saveInitialTableSnapshots`도 `startSession`도 각각은 멀쩡하고 **순서만**
 * 틀린 것이었다. 부품 테스트로는 영원히 잡히지 않는 종류다.
 *
 * **브라우저를 쓰지 않는 이유.** 플레이어 단말은 좌석에 고정된 태블릿이고
 * 조작할 수 있는 것은 버튼과 슬라이더뿐이다. 즉 브라우저가 보내는 것은 결국
 * 액션 하나다. 크롬 창 여섯 개를 띄우고 각각 로그인하던 수동 테스트가 여기서
 * 함수 호출 여섯 번이 된다. 프론트를 통째로 재구성할 예정이라 화면을 지금
 * 고정할 이유도 없다.
 *
 * **"어디서 터졌나"를 뽑아내는 방법이 이 파일의 설계를 정한다.**
 *
 * 1. 단계마다 `it`을 끊는다. 실패한 `it`의 이름이 곧 터진 지점이다.
 * 2. 단계가 끝날 때마다 `checkInvariants()`로 도메인 불변식을 전부 검사한다.
 *    마지막에 한 번만 보면 "어딘가에서 칩이 사라졌다"까지만 알 수 있다.
 *    T15의 사이드팟 증발이 정확히 그 모양이었다.
 *
 * 상태를 단계 사이에 이어가야 하므로 `it`들이 순서에 의존한다. 보통은 나쁜
 * 습관이지만, 여기서는 **순서 자체가 검증 대상**이다.
 */
describe('시나리오 — 대회 하나를 끝까지', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let queueConnection: Redis;
  let queue: Queue;

  let redisService: RedisService;
  let playsync: PlaysyncService;
  let dealer: DealerService;
  let session: SessionService;
  let payment: PaymentService;
  let user: UserService;

  const STORE = 'store-1';
  const OWNER = 'owner-1';
  const BLIND = 'blind-1';
  const START_STACK = 10000;
  const ENTRY_FEE = 1000;
  const INITIAL_POINTS = 50000;

  /** 6명. 대회 시작 최소 인원(MIN_PLAYERS_TO_START 기본값)과 같다. */
  const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];

  let tournamentId: string;
  let tableId: string;
  /** 시작 시점의 칩 총량. 이 대회가 끝날 때까지 변하면 안 된다. */
  let chipsAtStart: number;

  const snapshot = async (): Promise<TableState> => {
    const raw = await redis.get(`table:state:${tableId}`);
    if (!raw) throw new Error('스냅샷이 없다');
    return JSON.parse(raw);
  };

  const seatOf = (state: TableState, id: string) =>
    state.players.findIndex(p => p?.id === id);

  /**
   * 이 도메인에서 항상 참이어야 하는 것들.
   *
   * 단계마다 부르는 것이 요점이다. 틀어진 **첫 순간**을 잡아야 원인을 좁힐 수
   * 있다.
   */
  async function checkInvariants(label: string) {
    const state = await snapshot();

    // 1. 칩은 만들어지지도 사라지지도 않는다. 카드가 실물이라 부기가 틀리면
    //    되돌릴 근거가 테이블 위에 남지 않는다.
    const onTable =
      state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;
    expect(`${label}: 칩 ${onTable}`).toBe(`${label}: 칩 ${chipsAtStart}`);

    // 2. 사이드팟 총액은 팟과 일치한다. 갈리는 순간에만 의미가 있다.
    if (state.sidePots.length > 0) {
      const sum = state.sidePots.reduce((acc, p) => acc + p.amount, 0);
      expect(`${label}: 사이드팟합 ${sum}`).toBe(`${label}: 사이드팟합 ${state.pot}`);
    }

    // 3. 폴드한 사람은 어느 사이드팟의 자격자도 아니다 (T15).
    //
    // **쇼다운 이후로 한정한다.** `calculateSidePots`는 페이즈가 넘어갈 때만
    // 도는데, 라운드 중간에 누가 폴드해도 `state.sidePots`는 그대로 남는다.
    // 즉 다음 전환까지 폴드한 사람이 자격자 목록에 남아 클라이언트로 나간다.
    //
    // 지급에는 영향이 없다 — `resolveWinner`가 분배 직전에 다시 계산한다.
    // 그래서 돈이 걸린 구간에서만 검사한다. 다만 브로드캐스트되는 정보가
    // 한 페이즈 낡아 있는 것은 사실이고, 별도 티켓으로 다룬다.
    if (state.phase >= GamePhase.SHOWDOWN) {
      const folded = state.players.filter(p => p?.hasFolded).map(p => p!.id);
      for (const pot of state.sidePots) {
        for (const id of folded) {
          expect(`${label}: ${id} 자격 ${pot.relevantPlayerIds.includes(id)}`)
            .toBe(`${label}: ${id} 자격 false`);
        }
      }
    }

    // 4. 베팅 중이라면 차례인 사람은 실재하고, 폴드하지 않았고, 올인이 아니다.
    const betting = [
      GamePhase.PRE_FLOP, GamePhase.FLOP, GamePhase.TURN, GamePhase.RIVER,
    ].includes(state.phase);
    if (betting && state.currentTurnSeatIndex !== -1) {
      const turn = state.players[state.currentTurnSeatIndex];
      expect(`${label}: 차례 ${turn?.id ?? '없음'}`).not.toBe(`${label}: 차례 없음`);
      expect(`${label}: 차례 폴드 ${turn?.hasFolded}`).toBe(`${label}: 차례 폴드 false`);
      expect(`${label}: 차례 올인 ${turn?.isAllIn}`).toBe(`${label}: 차례 올인 false`);
    }

    // 5. 좌석 비트맵과 스냅샷의 착석자가 일치한다.
    const bitmap = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tableId}`);
    const seatedInBitmap = (bitmap ?? '').split('').filter(c => c === '1').length;
    const seatedInState = state.players.filter(p => p !== null).length;
    expect(`${label}: 비트맵 ${seatedInBitmap}`).toBe(`${label}: 비트맵 ${seatedInState}`);

    return state;
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
    redisService = new RedisService(redis);
    playsync = new PlaysyncService(queue, redisService, prismaService, emitter);
    session = new SessionService(prismaService, redisService);
    user = new UserService(prismaService);
    payment = new PaymentService(user, session, prismaService, redisService, emitter);
    dealer = new DealerService(
      queue, prismaService, redisService, playsync, {} as JwtService,
    );

    // 리바인 팝업은 사람의 응답을 기다린다. 장애 없는 해피패스만 보는
    // 시나리오이므로 짧게 두어 아무도 응답하지 않는 경우가 빨리 끝나게 한다.
    process.env.REBUY_TIMEOUT_MS = '50';
  });

  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  it('1. 상점과 대회가 준비된다', async () => {
    await prisma.user.create({
      data: { id: OWNER, nickname: 'owner', password: 'x', points: 0, role: 'STORE_ADMIN' },
    });
    await prisma.store.create({
      data: { id: STORE, name: '테스트 상점', ownerId: OWNER },
    });
    await prisma.blindStructure.create({
      data: {
        id: BLIND,
        name: '기본',
        storeId: STORE,
        // duration이 길어야 시나리오 도중에 레벨이 오르지 않는다.
        structure: [{ lv: 1, sb: 100, ante: false, duration: 60 }],
      },
    });

    await session.createSession({
      name: '시나리오 대회',
      type: 'TOURNAMENT',
      storeId: STORE,
      startStack: START_STACK,
      entryFee: ENTRY_FEE,
      rebuyUntil: 5,
      // 상금 분배율은 대회 생성 시 상점이 정한다. itmCount는 여기서 파생된다.
    prizePayouts: [{ place: 1, percent: 100 }],
      isRegistrationOpen: true,
      blindId: BLIND,
    } as never);

    // `createSession`은 아무것도 반환하지 않는다. 의도된 설계다 — 대회 정보와
    // 딜러 OTP는 상점 관리 페이지가 따로 조회해서 보여준다. 생성 응답에 OTP를
    // 실어 보내지 않으므로 여기서도 DB에서 찾는 것이 실제 사용 경로와 같다.
    const created = await prisma.tournament.findFirst({ where: { storeId: STORE } });
    expect(created).not.toBeNull();
    tournamentId = created!.id;

    const table = await prisma.table.findFirst({ where: { tournamentId } });
    expect(table).not.toBeNull();
    tableId = table!.id;
  });

  it('2. 유저가 포인트를 들고 존재한다', async () => {
    await prisma.user.createMany({
      data: PLAYERS.map(id => ({
        id, nickname: id, password: 'x', points: INITIAL_POINTS,
      })),
    });

    const rows = await prisma.user.findMany({ where: { id: { in: PLAYERS } } });
    expect(rows).toHaveLength(PLAYERS.length);
    expect(rows.every(r => r.points === INITIAL_POINTS)).toBe(true);
  });

  it('3. 6명이 좌석을 사서 앉는다', async () => {
    for (const [seat, id] of PLAYERS.entries()) {
      await payment.joinSessionWithSeat(
        { tournamentId, tableId, seatIndex: seat }, id,
      );
    }

    // 참가비가 실제로 빠졌는가. 스택은 아직 Redis에만 있다.
    const rows = await prisma.user.findMany({ where: { id: { in: PLAYERS } } });
    expect(rows.every(r => r.points === INITIAL_POINTS - ENTRY_FEE)).toBe(true);

    const state = await snapshot();
    expect(state.players.filter(p => p !== null)).toHaveLength(PLAYERS.length);
    expect(state.players.every(p => p === null || p.stack === START_STACK)).toBe(true);

    chipsAtStart = START_STACK * PLAYERS.length;
    await checkInvariants('착석');
  });

  it('4. 대회가 시작된다', async () => {
    await session.startSession(tournamentId);

    const row = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    expect(row!.status).toBe('ONGOING');
    expect(row!.startedAt).not.toBeNull();

    // T16: Redis의 블라인드 기준 시각과 DB의 startedAt이 같아야 한다.
    const blind = await redisService.getTournamentBlind(tournamentId);
    expect(blind!.startedAt).toBe(row!.startedAt!.getTime());

    await checkInvariants('시작');
  });

  it('5. 프리플랍이 열리고 블라인드가 걷힌다', async () => {
    await dealer.startPreFlop(tournamentId, tableId);

    const state = await checkInvariants('프리플랍');
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(state.pot).toBe(300); // SB 100 + BB 200
    expect(state.currentBet).toBe(200);

    // 첫 차례는 UTG — 빅블라인드 다음 사람이다.
    const bb = (state.buttonUser + 2) % PLAYERS.length;
    expect(state.currentTurnSeatIndex).toBe((bb + 1) % PLAYERS.length);
  });

  it('6. 전원이 콜해서 플랍으로 넘어간다', async () => {
    // 차례를 따라가며 콜한다. 스냅샷을 매번 다시 읽는 것이 요점이다 —
    // 순서는 엔진이 정하고, 테스트가 그것을 예단하면 검증이 아니라 복사가 된다.
    for (let i = 0; i < PLAYERS.length; i++) {
      const state = await snapshot();
      if (state.phase !== GamePhase.PRE_FLOP) break;

      const seat = state.currentTurnSeatIndex;
      const id = state.players[seat]!.id;
      const action = state.players[seat]!.bet === state.currentBet
        ? ActionType.CHECK
        : ActionType.CALL;

      await playsync.handleAction(id, tableId, { action } as never);
      await checkInvariants(`프리플랍 ${id} ${action}`);
    }

    const state = await snapshot();
    expect(state.phase).toBe(GamePhase.FLOP);
    expect(state.pot).toBe(200 * PLAYERS.length);
    expect(state.currentBet).toBe(0);
    // 새 라운드의 첫 차례는 버튼 다음 사람이다.
    expect(state.currentTurnSeatIndex).toBe((state.buttonUser + 1) % PLAYERS.length);
  });

  it('7. 플랍에서 넷이 폴드하고 둘이 남는다', async () => {
    const before = await snapshot();
    const survivors = [
      before.players[(before.buttonUser + 1) % PLAYERS.length]!.id,
      before.players[(before.buttonUser + 2) % PLAYERS.length]!.id,
    ];

    for (let i = 0; i < PLAYERS.length * 2; i++) {
      const state = await snapshot();
      if (state.phase !== GamePhase.FLOP) break;

      const seat = state.currentTurnSeatIndex;
      const id = state.players[seat]!.id;
      const action = survivors.includes(id) ? ActionType.CHECK : ActionType.FOLD;

      await playsync.handleAction(id, tableId, { action } as never);
      await checkInvariants(`플랍 ${id} ${action}`);
    }

    const state = await snapshot();
    expect(state.players.filter(p => p && !p.hasFolded)).toHaveLength(2);
    expect(state.phase).toBe(GamePhase.TURN);
  });

  it('8. 턴과 리버를 체크로 넘겨 쇼다운에 도달한다', async () => {
    for (let guard = 0; guard < 20; guard++) {
      const state = await snapshot();
      if (state.phase === GamePhase.SHOWDOWN) break;

      const seat = state.currentTurnSeatIndex;
      const id = state.players[seat]!.id;
      await playsync.handleAction(id, tableId, { action: ActionType.CHECK } as never);
      await checkInvariants(`${GamePhase[state.phase]} ${id} 체크`);
    }

    const state = await snapshot();
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.currentTurnSeatIndex).toBe(-1);
    expect(state.pot).toBe(200 * PLAYERS.length);
  });

  it('9. 딜러가 승자를 지명하면 팟이 전부 지급된다', async () => {
    const before = await snapshot();
    const winner = before.players.find(p => p && !p.hasFolded)!;
    const stackBefore = winner.stack;
    const pot = before.pot;

    await dealer.resolveWinners(tableId, tournamentId, [[winner.id]]);

    const state = await checkInvariants('정산');
    expect(state.players[seatOf(state, winner.id)]!.stack).toBe(stackBefore + pot);
    expect(state.pot).toBe(0);
  });

  it('10. 체크포인트가 DB에 찍히고 다음 핸드가 준비된다', async () => {
    const state = await snapshot();

    // 정산이 끝나면 WAITING으로 돌아온다 — 체크포인트가 성공했다는 뜻이다.
    expect(state.phase).toBe(GamePhase.WAITING);
    expect(state.sidePots).toHaveLength(0);
    expect(state.players.every(p => p === null || !p.hasFolded)).toBe(true);
    expect(state.players.every(p => p === null || p.bet === 0)).toBe(true);

    // Redis의 스택이 DB에 반영됐는가. 이 동기화가 조용히 실패하던 것이 N-6이다.
    const rows = await prisma.tablePlayer.findMany({ where: { tableId } });
    for (const row of rows) {
      const seat = state.players[row.seatPosition];
      expect(`${row.userId} DB ${row.currentStack}`)
        .toBe(`${row.userId} DB ${seat?.stack ?? 0}`);
    }

    await checkInvariants('다음 핸드');
  });

  it('11. 두 번째 핸드는 버튼이 옮겨간 채로 시작한다', async () => {
    const before = await snapshot();
    const previousButton = before.buttonUser;

    await dealer.startPreFlop(tournamentId, tableId);

    const state = await checkInvariants('두 번째 핸드');
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(state.buttonUser).not.toBe(previousButton);
    expect(state.pot).toBe(300);
  });
});
