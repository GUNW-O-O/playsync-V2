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

  function makePlayer(id: string, seatIndex: number, stack = 0): TablePlayer {
    return {
      id, tableId: TABLE, nickname: id, seatIndex, stack,
      bet: 0, hasFolded: false, hasChecked: false, isAllIn: false,
      totalContributed: 0,
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
        dealerOtp: 1234, entryFee: ENTRY_FEE, startStack: 10000,
        itmCount: PAYOUTS.length, prizePayouts: PAYOUTS,
        totalBuyinAmount: INITIAL_POOL,
        activePlayers: USERS.length, totalPlayers: USERS.length,
      },
    });
    const session = await prisma.dealerSession.create({ data: { tournamentId: TOURNAMENT } });
    await prisma.table.create({
      data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id },
    });

    for (const [i, nickname] of USERS.entries()) {
      const user = await prisma.user.create({ data: { id: nickname, nickname, password: 'x' } });
      await prisma.tournamentParticipation.create({
        data: { tournamentId: TOURNAMENT, userId: user.id, status: 'PLAYING' },
      });
      await prisma.tablePlayer.create({
        data: {
          tableId: TABLE, tournamentId: TOURNAMENT, userId: user.id,
          seatPosition: i, currentStack: 10000,
        },
      });
    }
  }

  function makeState(): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: USERS.map((u, i) => makePlayer(u, i, 10000)),
      buttonUser: 0, currentTurnSeatIndex: 0, pot: 0, sidePots: [],
      currentBet: 100, smallBlind: 50, ante: false, tournamentId: TOURNAMENT,
    };
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

  it('같은 탈락이 두 번 도착해도 상금을 두 번 주지 않는다', async () => {
    // 재시도가 붙는 순간 중복 도착은 정상 경로다(N-7). 카운터와 달리 상금은
    // 돈이라, 두 번 들어가면 되돌릴 근거가 없다.
    const broke = [makePlayer('carol', 2)];

    await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));
    await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard(3));

    expect((await prizeOf('carol')).prize).toBe(INITIAL_POOL * 0.2);
  });
});
