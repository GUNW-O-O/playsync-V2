import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from 'src/dealer/dealer.service';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { FINAL_TABLE_DEALER_BLOCKED } from 'src/store/session/final-table';
import { CLOSED_TOURNAMENT_WRITE } from 'src/store/session/tournament-status';
import { Dashboard } from 'shared/types/tournamentMeta';
import { PlaysyncService } from './playsync.service';
import * as playerOtp from '../payment/player-otp';
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
      rakePercent: 0,
      entryCount: 0,
      itmCount: 1,
      rebuyUntil: 0,
      avgStack: 10000,
      tournamentName: 'T',
      entryFee: 1000,
      startStack: 10000,
      prizePool: 3000,
      prizes: [{ place: 1, percent: 100, amount: 3000 }],
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
      ante: 0,
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
        dealerOtpHash: 'unused-hash', // 이 스펙은 로그인 경로를 검증하지 않는다.
        entryFee: 1000,
        startStack: 10000,
        activePlayers: 3,
        totalPlayers: 3,
      },
    });
    const session = await prisma.dealerSession.create({
      data: { tournamentId: TOURNAMENT },
    });
    await prisma.table.create({
      data: { id: TABLE, tournamentId: TOURNAMENT, dealerId: session.id, tableOrder: 1 },
    });

    for (const [i, nickname] of USERS.entries()) {
      const user = await prisma.user.create({
        data: { id: nickname, nickname, password: 'x' },
      });
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
          tableId: TABLE,
          tournamentId: TOURNAMENT,
          userId: user.id,
          seatPosition: i,
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
      new OtpAttempts(redis),
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
    }, [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }]);
    await redis.set(stateKey, JSON.stringify(makeState()));
  });

  // `Redis 정리 실패가 조용히 묻히지 않는다`가 `redisService`에 거는 spy는
  // 되돌리지 않으면 **뒤따르는 모든 테스트로 샌다** — 실제로 뒤에 붙인
  // 세 테스트가 전부 `redis down`으로 죽었다.
  afterEach(() => {
    jest.restoreAllMocks();
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

    /**
     * 아래 셋은 **DB와 Redis를 일부러 갈라 놓고 시작한다**(T60). 둘이 일치하는
     * 입력만 먹이면 "어느 쪽을 읽는가"가 증명되지 않는다 — T29에서 물린 함정이
     * 정확히 그것이었다.
     */
    it('등수를 Redis 대시보드가 아니라 DB에서 읽는다', async () => {
      // 대시보드는 3을 들고 있는데 DB는 2다(`dashboard()`의 activePlayer는 3).
      // 대시보드를 읽으면 3위, DB를 읽으면 2위다.
      await prisma.tournament.update({
        where: { id: TOURNAMENT },
        data: { activePlayers: 2 },
      });

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

      const row = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'carol' } },
      });
      expect(row.finalPlace).toBe(2);
    });

    it('Redis 카운터를 DB 값으로 맞춘다 — 갈라져 있어도', async () => {
      await redis.hset(infoKey, 'activePlayer', 9);

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

      expect(`redis ${await activePlayerInRedis()} / db ${await activePlayersInDb()}`)
        .toBe('redis 2 / db 2');
    });

    it('중복 도착도 어긋난 카운터를 고친다', async () => {
      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());
      await redis.hset(infoKey, 'activePlayer', 9); // 그 사이 누가 어긋뜨렸다

      await playsync.eliminatePlayer(TOURNAMENT, TABLE, [makePlayer('carol', 2, 0)], dashboard());

      expect(await activePlayerInRedis()).toBe(2);
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

    /**
     * 4-1. 킥은 DB만 깎고 Redis는 그대로 뒀다. 자가 치유 경로도 없다 —
     * `TableEngine.act`의 `DEALER_KICK`은 스택을 남기므로 `resolveWinners`의
     * `stack <= 0` 필터에 영원히 안 걸리고, 나중에 실제로 파산해도
     * `awardPrize`가 0행을 돌려줘 `eliCount === 0`에서 조기 반환한다.
     */
    it('킥이 Redis 인원도 깎는다', async () => {
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

      expect(`redis ${await activePlayerInRedis()} / db ${await activePlayersInDb()}`)
        .toBe('redis 2 / db 2');
    });

    it('두 번 킥해도 Redis 인원은 한 번만 준다 — 그 사이 어긋났어도', async () => {
      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');
      await redis.hset(infoKey, 'activePlayer', 9); // 그 사이 누가 어긋뜨렸다

      await dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK');

      expect(await activePlayerInRedis()).toBe(2);
    });
  });

  /**
   * 파이널 테이블의 딜러 개입 금지(T77).
   *
   * **이 절이 닫는 것은 위 「딜러 킥」 절이 못 닫은 구멍이다.** 킥은
   * `tournamentFinished`를 부르지 않으므로 헤즈업에서 킥이 일어나면
   * `activePlayers`가 1인데 대회를 닫을 경로가 없다. 위 절의 주석이 그것을
   * "규칙으로 막는다"고 적어 뒀고, 여기가 그 규칙이다.
   *
   * 시드는 등록이 열린 상태다(`isRegistrationOpen`의 스키마 기본값이 `true`).
   * 그래서 위 절의 킥들은 이 게이트에 걸리지 않는다 — **닫는 조건을 이
   * 절에서만 만든다.**
   */
  describe('파이널 테이블의 딜러 개입', () => {
    /** 등록을 마감한다. 테이블은 시드가 하나만 만든다. */
    async function closeRegistration() {
      await prisma.tournament.update({
        where: { id: TOURNAMENT },
        data: { isRegistrationOpen: false },
      });
    }

    it('킥을 거절한다', async () => {
      await closeRegistration();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow(FINAL_TABLE_DEALER_BLOCKED);
    });

    /**
     * **거절만으로는 부족하다.** 던지기 전에 이미 카운터를 깎았거나 참가를
     * `ELIMINATED`로 만들었으면, 대회는 여전히 닫을 수 없는 상태로 남는다 —
     * 이 티켓이 막으려던 바로 그 상태다. 게이트가 **부수효과보다 앞**에 있어야
     * 한다.
     */
    it('거절된 킥은 인원수를 건드리지 않는다', async () => {
      await closeRegistration();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow();

      expect(`redis ${await activePlayerInRedis()} / db ${await activePlayersInDb()}`)
        .toBe('redis 3 / db 3');
    });

    it('거절된 킥은 참가 상태를 건드리지 않는다', async () => {
      await closeRegistration();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow();

      const row = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'carol' } },
      });
      expect(row.status).not.toBe('ELIMINATED');
    });

    /** 폴드는 카운터와 무관하지만 같은 게이트에 걸린다. 근거는 공정성이다. */
    it('폴드도 거절한다', async () => {
      await closeRegistration();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'FOLD'),
      ).rejects.toThrow(FINAL_TABLE_DEALER_BLOCKED);
    });

    /**
     * **두 조건이 어긋나는 입력이다.** 마감만 풀고 테이블 수는 그대로 두면,
     * 게이트에서 `isRegistrationOpen` 항을 지웠을 때 이 검사가 빨간불이 된다.
     * 위 넷만으로는 그 항을 지워도 전부 초록이다.
     */
    it('등록이 열려 있으면 통과시킨다 — 테이블이 하나여도', async () => {
      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).resolves.toBeDefined();
    });

    /**
     * **컬럼이 마감을 늦게 안다.**
     *
     * `isRegistrationOpen` 컬럼은 마감 시각에 스스로 닫히지 않는다.
     * `PaymentService.closeRegistrationInDb`가 **마감 뒤 누군가 참가를
     * 시도했을 때만** 게으르게 flip하고, 그 외에는 상점의 수동 스위치다.
     * 그래서 마감 레벨을 지났는데도 그 뒤 아무도 참가를 시도하지 않은 대회는
     * 컬럼이 `true`로 남는다 — 헤즈업에 도달해도 게이트가 안 걸린다.
     *
     * 정본은 **레벨에서 파생된 값**이다(`isRegistrationOpenAtLevel`).
     * `getTournamentDashboard`가 `checkAndSyncBlindLevel`을 거쳐 그 값을
     * 돌려주고, Redis가 없으면 `isRegistrationOpenNow`가 DB만으로 같은 규칙을
     * 다시 센다. 결제 게이트가 이미 그 경로를 쓴다.
     */
    async function driftPastRegistrationClose() {
      // 컬럼은 열린 채로 둔다. 시작 시각만 과거로 밀어 레벨이 마감을 지나게
      // 한다 — 시드의 `rebuyUntil`은 0이라 첫 레벨부터 이미 마감이다.
      await prisma.tournament.update({
        where: { id: TOURNAMENT },
        data: { startedAt: new Date(Date.now() - 60_000) },
      });
    }

    it('컬럼이 열린 채여도 마감 레벨을 지났으면 거절한다', async () => {
      await driftPastRegistrationClose();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow(FINAL_TABLE_DEALER_BLOCKED);
    });

    /**
     * 읽은 김에 컬럼도 닫는다. 안 닫으면 다음 호출도 같은 파생을 다시 하고,
     * **컬럼을 읽는 다른 자리들은 영영 틀린 값을 본다.**
     */
    it('거절하면서 컬럼도 닫는다', async () => {
      await driftPastRegistrationClose();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow();

      const row = await prisma.tournament.findUniqueOrThrow({ where: { id: TOURNAMENT } });
      expect(row.isRegistrationOpen).toBe(false);
    });

    /**
     * 반대쪽 어긋남이다. 테이블을 하나 더 열면 마감됐어도 파이널 테이블이
     * 아니다 — 게이트에서 `tableCount` 항을 지우면 여기가 빨간불이 된다.
     */
    it('테이블이 둘이면 통과시킨다 — 마감됐어도', async () => {
      await closeRegistration();
      const session = await prisma.dealerSession.findFirstOrThrow({
        where: { tournamentId: TOURNAMENT },
      });
      await prisma.table.create({
        data: { id: 'table-2', tournamentId: TOURNAMENT, dealerId: session.id, tableOrder: 2 },
      });

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).resolves.toBeDefined();
    });
  });

  /**
   * **킥하는 사이에 대회가 닫힌다.**
   *
   * `handleDealerAction`은 맨 앞에서 대회 상태를 보는데 그 검사는 트랜잭션
   * **밖**이다. 늦게 도착한 킥은 그 검사가 잡지만, 검사를 통과한 뒤 커밋
   * 전에 닫히면 참가 행만 `ELIMINATED`가 되고 카운터는 죽은 대회 것이 된다.
   *
   * 창을 만드는 자리로 `mutateSnapshot`을 고른 이유: 상태 확인 **직후**이자
   * 트랜잭션 **직전**이라, 딱 그 사이에서만 닫힌다.
   */
  describe('킥하는 사이에 대회가 닫히면', () => {
    /** 스냅샷 락을 잡기 직전에 대회를 닫는다. 진짜를 부르되 앞에 시각 하나를 끼운다. */
    function closeMidAction() {
      const real = redisService.mutateSnapshot.bind(redisService);
      jest
        .spyOn(redisService, 'mutateSnapshot')
        .mockImplementation(async (...args: Parameters<typeof real>) => {
          await prisma.tournament.update({
            where: { id: TOURNAMENT },
            data: { status: 'CANCELLED' },
          });
          return real(...args);
        });
    }

    it('거절한다', async () => {
      closeMidAction();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow(CLOSED_TOURNAMENT_WRITE);
    });

    it('참가 상태와 인원수가 그대로다 — 같은 트랜잭션이라 함께 되돌아간다', async () => {
      closeMidAction();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow();

      const row = await prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: TOURNAMENT, userId: 'carol' } },
      });
      expect(`${row.status} / db ${await activePlayersInDb()}`).toBe('PLAYING / db 3');
    });

    /**
     * **Redis는 트랜잭션이 아니다.** 'KICKED' 대입이 트랜잭션 앞에 있으면
     * 거절된 킥이 그 자국을 남기고, 그 사람은 킥당하지 않았는데도 무엇을
     * 눌러도 폴드가 된다(`handleAction`의 `isKicked` 분기).
     */
    it('거절된 킥은 KICKED 자국을 남기지 않는다', async () => {
      closeMidAction();

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'KICK'),
      ).rejects.toThrow();

      const raw = await redis.hget(`tournament:${TOURNAMENT}:user`, 'carol');
      expect(raw === null ? '자국 없음' : String(JSON.parse(raw).status)).not.toBe('KICKED');
    });
  });

});
