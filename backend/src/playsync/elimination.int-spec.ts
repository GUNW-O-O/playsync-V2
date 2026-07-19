import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from 'src/dealer/dealer.service';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { Dashboard } from 'shared/types/tournamentMeta';
import { PlaysyncService } from './playsync.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 탈락 처리의 멱등성.
 *
 * DB를 스텁으로 두지 않고 진짜로 띄운다. 검증 대상이 "같은 탈락이 두 번 도착해도
 * 카운터가 한 번만 주는가"인데, 그 판정을 `where` 조건으로 DB에 맡기는 것이
 * 수정 방향이기 때문이다. 스텁을 쓰면 검증하려는 술어 자체가 사라진다.
 *
 * 왜 멱등이 필요한가: 재시도를 붙이는 순간 중복 도착이 정상 경로가 된다.
 * 지금은 재시도가 없어서 드러나지 않았을 뿐이다.
 */
describe('탈락 처리 멱등성', () => {
  let redis: Redis;
  let prisma: PrismaClient;
  let queueConnection: Redis;
  let queue: Queue;
  let redisService: RedisService;
  let playsync: PlaysyncService;
  let dealer: DealerService;

  const TOURNAMENT = 'tournament-1';
  const TABLE = 'table-1';
  const stateKey = `table:state:${TABLE}`;
  const infoKey = `tournament:${TOURNAMENT}:info`;

  const USERS = ['alice', 'bob', 'carol'];

  function dashboard(): Dashboard {
    return {
      isRegistrationOpen: false,
      totalPlayer: 3,
      activePlayer: 3,
      totalBuyinAmount: 3000,
      rebuyUntil: 0,
      avgStack: 10000,
      tournamentName: 'T',
      entryFee: 1000,
      startStack: 10000,
      itmCount: 1,
    };
  }

  function makePlayer(id: string, seatIndex: number, stack = 10000): TablePlayer {
    return {
      id,
      tableId: TABLE,
      nickname: id,
      seatIndex,
      stack,
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
      players: USERS.map((u, i) => makePlayer(u, i)),
      buttonUser: 0,
      currentTurnSeatIndex: 0,
      pot: 0,
      sidePots: [],
      currentBet: 100,
      smallBlind: 50,
      ante: false,
      tournamentId: TOURNAMENT,
    };
  }

  /** 토너먼트 한 개와 참가자 3명. FK가 요구하는 최소 그래프만 만든다. */
  async function seedDb() {
    const owner = await prisma.user.create({
      data: { nickname: 'owner', password: 'x' },
    });
    const store = await prisma.store.create({
      data: { name: 'store-1', ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: 'blind-1',
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await prisma.tournament.create({
      data: {
        id: TOURNAMENT,
        name: 'T',
        blindId: blind.id,
        storeId: store.id,
        dealerOtp: 1234,
        entryFee: 1000,
        startStack: 10000,
        itmCount: 1,
        activePlayers: 3,
        totalPlayers: 3,
      },
    });
    const session = await prisma.dealerSession.create({
      data: { tournamentId: TOURNAMENT },
    });
    await prisma.table.create({
      data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id },
    });

    for (const [i, nickname] of USERS.entries()) {
      const user = await prisma.user.create({
        data: { id: nickname, nickname, password: 'x' },
      });
      await prisma.tournamentParticipation.create({
        data: { tournamentId: TOURNAMENT, userId: user.id, status: 'PLAYING' },
      });
      await prisma.tablePlayer.create({
        data: {
          tableId: TABLE,
          tournamentId: TOURNAMENT,
          userId: user.id,
          seatPosition: i,
          currentStack: 10000,
        },
      });
    }
  }

  async function activePlayersInDb(): Promise<number> {
    const row = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
    return row.activePlayers;
  }

  async function activePlayerInRedis(): Promise<number> {
    return Number(await redis.hget(infoKey, 'activePlayer'));
  }

  beforeAll(() => {
    redis = createTestRedis();
    prisma = createTestPrisma();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });

    redisService = new RedisService(redis);
    playsync = new PlaysyncService(
      queue,
      redisService,
      prisma as unknown as PrismaService,
      new EventEmitter2(),
    );
    dealer = new DealerService(
      queue,
      prisma as unknown as PrismaService,
      redisService,
      playsync,
      {} as JwtService,
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
    await redisService.setTournamentMeta(TOURNAMENT, dashboard(), {
      isBreak: false,
      startedAt: Date.now(),
      currentBlindLv: 0,
      nextLevelAt: Date.now() + 600000,
      serverTime: Date.now(),
      blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
    });
    await redis.set(stateKey, JSON.stringify(makeState()));
  });

  describe('eliminatePlayer', () => {
    it('같은 유저의 탈락이 두 번 도착해도 카운터는 한 번만 준다', async () => {
      const broke = [makePlayer('carol', 2, 0)];

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard());
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard());

      expect(await activePlayersInDb()).toBe(2);
    });

    it('Redis 카운터도 한 번만 준다', async () => {
      const broke = [makePlayer('carol', 2, 0)];

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard());
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard());

      expect(await activePlayerInRedis()).toBe(2);
    });

    it('Redis 정리 실패가 조용히 묻히지 않는다', async () => {
      // N-4: map 콜백이 블록인데 return이 없어 Promise.all이 undefined[]를 받는다.
      // await가 붙어 있지만 실제로는 fire-and-forget이라, 정리가 실패해도
      // 성공으로 끝난다.
      const broke = [makePlayer('carol', 2, 0)];
      jest
        .spyOn(redisService, 'deleteUserContext')
        .mockRejectedValue(new Error('redis down'));

      await expect(
        playsync.eliminatePlayer(TOURNAMENT, TABLE, broke, dashboard()),
      ).rejects.toThrow();
    });
  });

  describe('딜러 킥', () => {
    it('같은 유저를 두 번 킥해도 카운터는 한 번만 준다', async () => {
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

      expect(await activePlayersInDb()).toBe(2);
    });

    it('두 번 킥해도 참가 상태는 ELIMINATED 하나로 남는다', async () => {
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

      const row = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'carol' } },
      });
      expect(row.status).toBe('ELIMINATED');
    });
  });
});
