import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Dashboard } from 'shared/types/tournamentMeta';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { PlaysyncService } from './playsync.service';
import * as playerOtp from '../payment/player-otp';

/**
 * 상금 지급.
 *
 * 걷는 쪽은 이미 맞게 돌고 있었다 — `totalBuyinAmount`가 참가와 리바인 양쪽에서
 * 누적된다. 없던 것은 내보내는 쪽이다. 인 더 머니 탈락은 무조건 `1000`,
 * 우승은 무조건 `3000`이었다. 참가비가 10만 원이든 1천 원이든 같았다.
 *
 * DB를 진짜로 띄우는 이유: 검증 대상이 "지급 금액이 그 시점의 풀에서 나오는가"라
 * 풀을 누적하는 주체(DB 컬럼)를 스텁으로 바꾸면 검증할 것이 남지 않는다.
 */
describe('상금 지급', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let queueConnection: Redis;
  let queue: Queue;
  let redisService: RedisService;
  let playsync: PlaysyncService;

  const TOURNAMENT = 'tournament-1';
  const TABLE = 'table-1';
  /** 교차 테이블 동시 정산에만 쓴다. `seedDb`는 만들지 않는다. */
  const TABLE2 = 'table-2';
  const USERS = ['alice', 'bob', 'carol', 'dave'];

  const ENTRY_FEE = 10000;
  /** 4명이 한 번씩 냈다. 리바인이 붙으면 여기서 더 커진다. */
  const INITIAL_POOL = ENTRY_FEE * USERS.length;

  const PAYOUTS = [
    { place: 1, percent: 50 },
    { place: 2, percent: 30 },
    { place: 3, percent: 20 },
  ];

  function dashboard(activePlayer: number): Dashboard {
    return {
      isRegistrationOpen: false,
      totalPlayer: USERS.length,
      activePlayer,
      totalBuyinAmount: INITIAL_POOL,
      rebuyUntil: 0,
      avgStack: 10000,
      tournamentName: 'T',
      entryFee: ENTRY_FEE,
      startStack: 10000,
      itmCount: PAYOUTS.length,
      prizePool: INITIAL_POOL,
      prizes: PAYOUTS.map(p => ({ ...p, amount: 0 })),
    };
  }

  /**
   * @param totalContributed 이 핸드에 이미 팟으로 나간 칩. `stack`과 더한 값이
   *   곧 **핸드 시작 스택**이고, 동시 파산의 등수를 그 값이 가른다(T59).
   *   파산자는 `stack === 0`이라 실질적으로 이 값이 답이다.
   */
  function makePlayer(
    id: string, seatIndex: number, stack = 0, totalContributed = 0,
    tableId = TABLE,
  ): TablePlayer {
    return {
      id, tableId, nickname: id, seatIndex, stack,
      bet: 0, hasFolded: false, hasChecked: false, isAllIn: false,
      totalContributed,
    };
  }

  async function seedDb() {
    const owner = await prisma.user.create({ data: { nickname: 'owner', password: 'x' } });
    const store = await prisma.store.create({ data: { name: 'store-1', ownerId: owner.id } });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'blind-1', storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT, name: 'T', blindId: blind.id, storeId: store.id,
        dealerOtpHash: 'unused-hash', // 이 스펙은 로그인 경로를 검증하지 않는다.
        entryFee: ENTRY_FEE, startStack: 10000,
        itmCount: PAYOUTS.length, prizePayouts: PAYOUTS,
        totalBuyinAmount: INITIAL_POOL,
        activePlayers: USERS.length, totalPlayers: USERS.length,
      },
    });
    const session = await prisma.dealerSession.create({ data: { tournamentId: TOURNAMENT } });
    await prisma.table.create({
      data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id, tableOrder: 1 },
    });

    for (const [i, nickname] of USERS.entries()) {
      const user = await prisma.user.create({ data: { id: nickname, nickname, password: 'x' } });
      await prisma.tournamentParticipation.create({
        data: {
          tournamentId: TOURNAMENT,
          userId: user.id,
          status: 'PLAYING',
          currentStack: 10000,
          playerOtp: playerOtp.generatePlayerOtp(),
        },
      });
      await prisma.tablePlayer.create({
        data: {
          tableId: TABLE, tournamentId: TOURNAMENT, userId: user.id,
          seatPosition: i,
        },
      });
    }
  }

  function makeState(): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: USERS.map((u, i) => makePlayer(u, i, 10000)),
      buttonUser: 0, currentTurnSeatIndex: 0, pot: 0, sidePots: [],
      currentBet: 100, smallBlind: 50, ante: 0, tournamentId: TOURNAMENT,
    };
  }

  /**
   * 남은 인원을 DB에 세운다.
   *
   * 등수는 T60 이후 **DB `Tournament.activePlayers`**에서 온다 — 예전에는
   * `eliminatePlayer`에 넘긴 `Dashboard.activePlayer`(Redis 캐시)였고,
   * 등수가 상금을 정하므로 그 입력이 화면용 파생값인 것 자체가 위험했다.
   * 그래서 "n위로 탈락한다"를 만들려면 여기를 세워야 한다.
   *
   * 순서대로 탈락시키는 테스트(`지급 총액은 풀과 정확히 같다`)는 부를 필요가
   * 없다 — 그쪽은 DB가 4 → 3 → 2로 스스로 내려간다.
   */
  async function remaining(count: number) {
    await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { activePlayers: count },
    });
  }

  async function prizeOf(userId: string) {
    const row = await prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: TOURNAMENT, userId },
    });
    return { prize: row.prizeAmount, place: row.finalPlace, status: row.status };
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });
    redisService = new RedisService(redis);
    playsync = new PlaysyncService(
      queue, redisService, prisma as unknown as PrismaService, new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
    await seedDb();
    await redisService.setTournamentMeta(TOURNAMENT, dashboard(USERS.length), {
      isBreak: false, startedAt: Date.now(), currentBlindLv: 0,
      nextLevelAt: Date.now() + 600000, serverTime: Date.now(),
      blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
    });
    await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
  });

  it('상금권 밖에서 탈락하면 0원이다', async () => {
    // 4명 중 4위. itmCount가 3이므로 상금이 없다.
    await playsync.eliminatePlayer(
      TOURNAMENT, TABLE, [makePlayer('dave', 3)], dashboard(4),
    );

    const dave = await prizeOf('dave');
    expect(dave.place).toBe(4);
    expect(dave.prize).toBe(0);
    expect(dave.status).toBe('ELIMINATED');
  });

  it('상금권 안에서 탈락하면 그 등수의 몫을 받는다', async () => {
    // 3위 = 풀의 20%. 상수 1000이 아니라 40000 × 0.2 = 8000이다.
    await remaining(3);

    await playsync.eliminatePlayer(
      TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3),
    );

    const carol = await prizeOf('carol');
    expect(carol.place).toBe(3);
    expect(carol.prize).toBe(INITIAL_POOL * 0.2);
    expect(carol.status).toBe('AWARDED');
  });

  it('우승자는 1위 몫을 받는다', async () => {
    // 마지막 한 명이 남으면 tournamentFinished가 돈다. 상수 3000이 아니다.
    await prisma.tournamentParticipation.updateMany({
      where: { tournamentId: TOURNAMENT, userId: { in: ['bob', 'carol', 'dave'] } },
      data: { status: 'ELIMINATED' },
    });

    await playsync.tournamentFinished(TOURNAMENT);

    const alice = await prizeOf('alice');
    expect(alice.place).toBe(1);
    expect(alice.prize).toBe(INITIAL_POOL * 0.5);
    expect(alice.status).toBe('AWARDED');
  });

  it('리바인으로 커진 풀이 상금에 반영된다', async () => {
    // 리바인은 참가비를 다시 받는다. 그 돈이 풀에 안 들어가면 어디로 갔는지
    // 설명할 수 없다 — 걷은 돈과 나간 돈이 어긋나는 것 자체가 버그다.
    await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { totalBuyinAmount: { increment: ENTRY_FEE * 2 } },
    });
    const pool = INITIAL_POOL + ENTRY_FEE * 2;
    await remaining(3);

    await playsync.eliminatePlayer(
      TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3),
    );

    expect((await prizeOf('carol')).prize).toBe(pool * 0.2);
  });

  it('지급 총액은 풀과 정확히 같다', async () => {
    // 나머지 원이 사라지면 사이드팟 증발(T15)과 같은 모양이 된다. 나누어
    // 떨어지지 않는 풀을 일부러 만든다.
    const pool = INITIAL_POOL + 7;
    await prisma.tournament.update({
      where: { id: TOURNAMENT },
      data: { totalBuyinAmount: pool },
    });

    await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('dave', 3)], dashboard(4));
    await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3));
    await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('bob', 1)], dashboard(2));

    const rows = await prisma.tournamentParticipation.findMany({
      where: { tournamentId: TOURNAMENT },
    });
    const paid = rows.reduce((sum, r) => sum + r.prizeAmount, 0);
    expect(`지급 ${paid}`).toBe(`지급 ${pool}`);
  });

  describe('전광판', () => {
    // 전광판은 Redis를 읽는다. 리바인이 들어올 때마다 totalBuyinAmount가
    // hincrby로 올라가므로, 프라이즈풀도 그 자리에서 같이 커져야 한다.
    // 대회 중에 참가자가 보는 숫자가 이것이다.

    it('프라이즈풀과 등수별 상금을 함께 내보낸다', async () => {
      const info = await redisService.getFullTournamentInfo(TOURNAMENT);

      expect(info!.dashboard.prizePool).toBe(INITIAL_POOL);
      expect(info!.dashboard.prizes).toEqual([
        { place: 1, percent: 50, amount: INITIAL_POOL * 0.5 },
        { place: 2, percent: 30, amount: INITIAL_POOL * 0.3 },
        { place: 3, percent: 20, amount: INITIAL_POOL * 0.2 },
      ]);
    });

    it('리바인이 들어오면 전광판 상금이 즉시 커진다', async () => {
      // 참가비를 한 번 더 받았는데 전광판이 그대로면, 그 돈이 상금이 되는지
      // 참가자가 알 수 없다. 리바인할 이유가 화면에서 사라진다.
      await redisService.rebuyPlayer(TOURNAMENT, ENTRY_FEE, 10000);

      const info = await redisService.getFullTournamentInfo(TOURNAMENT);
      const pool = INITIAL_POOL + ENTRY_FEE;

      expect(info!.dashboard.prizePool).toBe(pool);
      expect(info!.dashboard.prizes[0].amount).toBe(pool * 0.5);
    });

    it('전광판 상금 합계도 풀과 같다', async () => {
      const info = await redisService.getFullTournamentInfo(TOURNAMENT);
      const sum = info!.dashboard.prizes.reduce((s, p) => s + p.amount, 0);

      expect(`전광판 합계 ${sum}`).toBe(`전광판 합계 ${info!.dashboard.prizePool}`);
    });
  });

  describe('실지급', () => {
    /**
     * 상금이 **참가자 행에 적히는 것**과 **유저가 쓸 수 있게 되는 것**은 다르다.
     *
     * 참가비는 포인트에서 빠진다(`joinSession`, `executeRebuyTransaction`).
     * 상금이 포인트로 돌아오지 않으면 대회를 열 때마다 시스템이 포인트를
     * 삼킨다. `TransactionType.PRIZE`가 스키마에 있는데 쓰는 코드가 없었던
     * 것이 그 증거다.
     */

    async function pointsOf(userId: string) {
      return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).points;
    }

    it('상금만큼 포인트가 오른다', async () => {
      const before = await pointsOf('carol');
      await remaining(3);

      await playsync.eliminatePlayer(
        TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3),
      );

      expect(await pointsOf('carol')).toBe(before + INITIAL_POOL * 0.2);
    });

    it('PRIZE 거래 내역이 남는다', async () => {
      // 잔고만 올리면 왜 올랐는지 설명할 근거가 없다. 참가비(BUY_IN)와
      // 리바인(REBUY)은 이미 내역을 남긴다.
      await remaining(3);

      await playsync.eliminatePlayer(
        TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3),
      );

      const rows = await prisma.pointTransaction.findMany({
        where: { userId: 'carol', type: 'PRIZE' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].amount).toBe(INITIAL_POOL * 0.2);
      expect(rows[0].tournamentId).toBe(TOURNAMENT);
    });

    it('상금권 밖이면 포인트도 내역도 없다', async () => {
      const before = await pointsOf('dave');

      await playsync.eliminatePlayer(
        TOURNAMENT, TABLE, [makePlayer('dave', 3)], dashboard(4),
      );

      expect(await pointsOf('dave')).toBe(before);
      expect(await prisma.pointTransaction.count({
        where: { userId: 'dave', type: 'PRIZE' },
      })).toBe(0);
    });

    it('우승 상금도 포인트로 들어온다', async () => {
      await prisma.tournamentParticipation.updateMany({
        where: { tournamentId: TOURNAMENT, userId: { in: ['bob', 'carol', 'dave'] } },
        data: { status: 'ELIMINATED' },
      });
      const before = await pointsOf('alice');

      await playsync.tournamentFinished(TOURNAMENT);

      expect(await pointsOf('alice')).toBe(before + INITIAL_POOL * 0.5);
    });

    it('중복 도착에도 두 번 들어가지 않는다', async () => {
      // 카운터가 두 번 줄어드는 것과 달리 돈은 되돌릴 근거가 없다.
      const before = await pointsOf('carol');
      const broke = [makePlayer('carol', 2)];
      await remaining(3);

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));

      expect(await pointsOf('carol')).toBe(before + INITIAL_POOL * 0.2);
      expect(await prisma.pointTransaction.count({
        where: { userId: 'carol', type: 'PRIZE' },
      })).toBe(1);
    });

    it('대회가 끝나면 나간 포인트가 전부 돌아온다', async () => {
      // **이 대회의 회계가 맞는가.** 참가비로 걷은 만큼이 상금으로 나가야
      // 한다. 한쪽만 도는 동안은 아무도 눈치채지 못한다.
      const totalBefore = await totalPoints();

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('dave', 3)], dashboard(4));
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2)], dashboard(3));
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('bob', 1)], dashboard(2));

      // 참가비는 이 테스트의 seedDb가 이미 걷은 것으로 두고 있으므로,
      // 지급된 총액이 곧 풀 전체여야 한다.
      expect(`총 포인트 ${await totalPoints()}`)
        .toBe(`총 포인트 ${totalBefore + INITIAL_POOL}`);
    });

    async function totalPoints() {
      const users = await prisma.user.findMany({ where: { id: { in: USERS } } });
      return users.reduce((sum, u) => sum + u.points, 0);
    }
  });

  it('같은 탈락이 두 번 도착해도 상금을 두 번 주지 않는다', async () => {
    // 재시도가 붙는 순간 중복 도착은 정상 경로다(N-7). 카운터와 달리 상금은
    // 돈이라, 두 번 들어가면 되돌릴 근거가 없다.
    const broke = [makePlayer('carol', 2)];
    await remaining(3);

    await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));
    await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));

    expect((await prizeOf('carol')).prize).toBe(INITIAL_POOL * 0.2);
  });

  /**
   * 한 핸드에 둘 이상이 파산하는 경우 (T59).
   *
   * `DealerService.resolveWinners` 3단계가 `stack <= 0`인 사람을 **한 배열로**
   * 넘긴다. 사이드팟이 갈리는 표준 핸드(숏스택 둘이 올인)면 흔한 배치인데,
   * 예전에는 등수와 금액을 루프 밖에서 한 번 계산해 전원에게 같은 값을 매겼다 —
   * 3위 상금이 두 번 나가고 2위는 아무도 못 받았다.
   *
   * 기존 스펙이 이 결함을 못 잡은 이유는 **전부 한 명씩** 탈락시켜서다.
   */
  describe('동시 파산', () => {
    /**
     * 셋만 남은 판을 만든다. 여기서 둘이 함께 파산하면 2위·3위가 한꺼번에
     * 정해지고, 남은 한 명이 우승한다 — 결함 대장이 실측한 배치 그대로다.
     */
    async function threeLeft() {
      await prisma.tournamentParticipation.updateMany({
        where: { tournamentId: TOURNAMENT, userId: 'alice' },
        data: { status: 'ELIMINATED' },
      });
      await remaining(3);
    }

    it('핸드 시작 스택이 큰 쪽이 높은 등수와 그 등수의 몫을 받는다', async () => {
      await threeLeft();

      // 배열 순서가 아니라 스택이 정한다는 것을 보이려고 작은 쪽을 먼저 넣는다.
      // 예전에는 둘 다 `3위 8000원`이었다.
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [
        makePlayer('dave', 3, 0, 1000),
        makePlayer('carol', 2, 0, 3000),
      ], dashboard(3));

      const carol = await prizeOf('carol');
      const dave = await prizeOf('dave');
      expect(`carol ${carol.place}위 ${carol.prize}원`).toBe('carol 2위 12000원');
      expect(`dave ${dave.place}위 ${dave.prize}원`).toBe('dave 3위 8000원');
    });

    it('둘이 함께 파산해도 나간 상금 총액이 풀과 정확히 같다', async () => {
      // **이 대회를 닫을 수 있는가**가 걸린 단언이다. 같은 등수가 두 번
      // 나가면 합계가 풀에 못 미쳐 `completeSession`의 회계 게이트가 영영
      // 안 열리고, 손으로 메울 API도 없다.
      await threeLeft();

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [
        makePlayer('carol', 2, 0, 3000),
        makePlayer('dave', 3, 0, 1000),
      ], dashboard(3));

      const rows = await prisma.tournamentParticipation.findMany({
        where: { tournamentId: TOURNAMENT },
      });
      const paid = rows.reduce((sum, r) => sum + r.prizeAmount, 0);
      expect(`지급 ${paid}`).toBe(`지급 ${INITIAL_POOL}`);
    });

    it('같은 배치가 두 번 도착해도 상금은 한 번만 나간다', async () => {
      // 재시도가 붙은 뒤로 중복 도착은 정상 경로다. 여러 명을 한 배열로
      // 넘기는 새 경로에서도 멱등이 성립해야 한다.
      await threeLeft();
      const broke = [makePlayer('carol', 2, 0, 3000), makePlayer('dave', 3, 0, 1000)];

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));

      const rows = await prisma.tournamentParticipation.findMany({
        where: { tournamentId: TOURNAMENT },
      });
      const paid = rows.reduce((sum, r) => sum + r.prizeAmount, 0);
      const txCount = await prisma.pointTransaction.count({
        where: { tournamentId: TOURNAMENT, type: 'PRIZE' },
      });
      expect(`지급 ${paid} / 내역 ${txCount}건`)
        .toBe(`지급 ${INITIAL_POOL} / 내역 3건`);
    });

    it('같은 배치가 동시에 두 번 도착해도 인원이 한 번만 준다', async () => {
      // 인원 확정이 지급보다 **앞으로** 왔다. 예전에는 `updateMany` 하나가
      // 잠금과 판정을 함께 해서 이 창이 없었는데, 세는 문장만 앞에 두면
      // 둘 다 "한 명"을 세고 둘 다 카운터를 깎는다. 순차 중복으로는 안
      // 드러난다 — 앞이 커밋한 뒤에 뒤가 세기 때문이다.
      await threeLeft();
      const broke = [makePlayer('carol', 2, 0, 3000)];

      await bothBlockedOnTournamentRow(() => Promise.all([
        playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3)),
        playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3)),
      ]));

      const { activePlayers } = await prisma.tournament.findUniqueOrThrow({
        where: { id: TOURNAMENT },
      });
      const carol = await prizeOf('carol');
      expect(`남은 ${activePlayers} / carol ${carol.place}위 ${carol.prize}원`)
        .toBe('남은 2 / carol 3위 8000원');
    });

    it('두 테이블이 동시에 정산해도 등수가 겹치지 않는다', async () => {
      // 스택 비교로는 못 푼다 — 다른 테이블의 파산자는 이 배열에 없다.
      // `activePlayers`를 먼저 깎아 등수 **구간**을 원자적으로 받는 것이
      // 유일한 방법이고, 그래서 두 트랜잭션을 **실제로 겹치게** 띄운다.
      await threeLeft();
      await moveToSecondTable('dave');

      await bothBlockedOnTournamentRow(() => Promise.all([
        playsync.eliminatePlayer(
          TOURNAMENT, TABLE, [makePlayer('carol', 2, 0, 3000)], dashboard(3),
        ),
        playsync.eliminatePlayer(
          TOURNAMENT, TABLE2, [makePlayer('dave', 0, 0, 1000, TABLE2)], dashboard(3),
        ),
      ]));

      // 어느 쪽이 먼저 커밋하는지는 정하지 않는다 — 다른 테이블의 스택은
      // 비교 대상이 아니다. **겹치지 않는 것**이 규칙이다.
      const places = [
        (await prizeOf('carol')).place,
        (await prizeOf('dave')).place,
      ].sort((a, b) => Number(a) - Number(b));
      expect(`등수 ${places.join(',')}`).toBe('등수 2,3');

      const rows = await prisma.tournamentParticipation.findMany({
        where: { tournamentId: TOURNAMENT },
      });
      const paid = rows.reduce((sum, r) => sum + r.prizeAmount, 0);
      expect(`지급 ${paid}`).toBe(`지급 ${INITIAL_POOL}`);
    });

    /** 두 번째 테이블을 열고 그 사람의 좌석 행을 옮긴다. */
    async function moveToSecondTable(userId: string) {
      const session = await prisma.dealerSession.findFirstOrThrow({
        where: { tournamentId: TOURNAMENT },
      });
      await prisma.table.create({
        data: { id: TABLE2, tournamentId: TOURNAMENT, dealerId: session.id, tableOrder: 2 },
      });
      await prisma.tablePlayer.updateMany({
        where: { tournamentId: TOURNAMENT, userId },
        data: { tableId: TABLE2, seatPosition: 0 },
      });
    }

    /**
     * 두 탈락 트랜잭션이 **같은 순간에 살아 있게** 만든다.
     *
     * 순차로 부르면 지금 코드도 통과한다 — 앞의 트랜잭션이 커밋한 뒤에 뒤가
     * 읽으므로 등수가 저절로 갈린다. T29에서 물린 "둘이 어긋나는 입력"과 같은
     * 함정이다.
     *
     * 그래서 제3의 트랜잭션이 대회 행을 `FOR UPDATE`로 붙잡은 채 둘을 띄운다.
     * 둘 다 대회 행을 건드리는 문장 앞에서 멈추고, 잠금을 놓는 순간 같은
     * 구간을 놓고 만난다.
     *
     * **대기를 `sleep`으로 재지 않는다** — 느린 기계에서 조용히 순차 실행이
     * 되면 이 테스트는 아무것도 검사하지 않게 된다. 잠금을 기다리는 백엔드가
     * 둘이 될 때까지 `pg_stat_activity`를 본다.
     */
    async function bothBlockedOnTournamentRow<T>(run: () => Promise<T>): Promise<T> {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let acquired!: () => void;
      const ready = new Promise<void>(resolve => { acquired = resolve; });

      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${TOURNAMENT} FOR UPDATE`;
        acquired();
        await held;
      }, { timeout: 30000 });

      await ready;
      const running = run();
      try {
        await waitForLockWaiters(2);
      } finally {
        release();
      }
      await blocker;
      return await running;
    }

    async function waitForLockWaiters(count: number) {
      for (let tries = 0; tries < 400; tries++) {
        const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        if (Number(row.n) >= count) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`잠금을 기다리는 트랜잭션이 ${count}개가 되지 않았다`);
    }
  });
});
