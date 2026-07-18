import { JwtService } from '@nestjs/jwt';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from './dealer.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { BlindField, Dashboard } from 'shared/types/tournamentMeta';
import { TableEngine } from 'src/game-engine/table-engine';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 딜러 경로의 동시성 계약.
 *
 * 이 프로젝트에서 딜러는 사람이고, 실물 카드를 딜링한 뒤 버튼을 눌러 게임을
 * 진행시킨다. 즉 딜러 경로와 플레이어 경로가 같은 테이블 상태를 동시에
 * 건드리는 것은 예외 상황이 아니라 기본 시나리오다.
 */
describe('DealerService 동시성', () => {
  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let redisService: RedisService;
  let dealer: DealerService;
  let playsync: PlaysyncService;

  const TABLE = 'table-1';
  const TOURNAMENT = 'tournament-1';
  const stateKey = `table:state:${TABLE}`;

  function makePlayer(id: string, seatIndex: number, overrides: Partial<TablePlayer> = {}): TablePlayer {
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
      ...overrides,
    };
  }

  function makeState(overrides: Partial<TableState> = {}): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: [makePlayer('alice', 0), makePlayer('bob', 1), makePlayer('carol', 2)],
      buttonUser: 0,
      currentTurnSeatIndex: 0,
      pot: 0,
      sidePots: [],
      currentBet: 100,
      smallBlind: 50,
      ante: false,
      actionDeadline: Date.now() + 30000,
      tournamentId: TOURNAMENT,
      ...overrides,
    };
  }

  /**
   * 대시보드와 블라인드를 한 번에 심는다.
   *
   * `setTournamentMeta`를 쓰는 이유: 대시보드는 Redis 해시에 **평탄화**되어
   * 저장되고 `getFullTournamentInfo`가 개별 필드를 읽는다. 다른 형태로 심으면
   * 전부 기본값(`isRegistrationOpen: false`)으로 읽혀서, 테스트가 아무 말 없이
   * 다른 시나리오를 검증하게 된다.
   */
  async function seedMeta(isRegistrationOpen = false) {
    const blind: BlindField = {
      isBreak: false,
      startedAt: Date.now(),
      currentBlindLv: 0,
      nextLevelAt: Date.now() + 600000,
      serverTime: Date.now(),
      blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
    };
    const dashboard: Dashboard = {
      isRegistrationOpen,
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
    await redisService.setTournamentMeta(TOURNAMENT, dashboard, blind);
  }

  function chipTotal(state: TableState): number {
    return state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;
  }

  beforeAll(() => {
    redis = createTestRedis();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });

    redisService = new RedisService(redis);
    const prisma = {} as PrismaService;
    playsync = new PlaysyncService(queue, redisService, prisma, new EventEmitter2());
    dealer = new DealerService(
      queue,
      prisma,
      redisService,
      playsync,
      {} as JwtService,
    );
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await seedMeta();
  });

  it('딜러 폴드가 겹쳐도 플레이어의 베팅이 사라지지 않는다', async () => {
    await redis.set(stateKey, JSON.stringify(makeState()));

    // 턴 주인 alice가 레이즈하는 순간, 딜러가 carol을 폴드시킨다.
    // 락이 없으면 둘이 같은 스냅샷을 읽고, 나중에 저장한 쪽이 상대의
    // 결과를 통째로 덮어쓴다.
    await Promise.all([
      playsync.handleAction('alice', TABLE, { action: ActionType.RAISE, amount: 1000 }),
      dealer.handleDealerAction(TOURNAMENT, TABLE, 'carol', 'FOLD'),
    ]);

    const state: TableState = JSON.parse((await redis.get(stateKey))!);

    // 두 결과가 모두 남아 있어야 한다.
    expect(state.pot).toBe(1000);
    expect(state.players[0]!.stack).toBe(9000);
    expect(state.players[2]!.hasFolded).toBe(true);
    expect(chipTotal(state)).toBe(30000);
  });

  it('핸드 시작이 겹쳐도 블라인드가 두 번 걷히지 않는다', async () => {
    await redis.set(stateKey, JSON.stringify(makeState({ phase: GamePhase.WAITING })));

    // 딜러가 버튼을 두 번 누르거나, 요청이 중복 도착한 경우.
    const results = await Promise.allSettled([
      dealer.startPreFlop(TOURNAMENT, TABLE),
      dealer.startPreFlop(TOURNAMENT, TABLE),
    ]);

    // 직렬화되면 두 번째 호출은 phase가 이미 WAITING이 아니라 거절된다.
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);

    const state: TableState = JSON.parse((await redis.get(stateKey))!);
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(state.pot).toBe(300); // SB 100 + BB 200
    expect(chipTotal(state)).toBe(30000);
  });

  describe('시작할 수 없는 상태', () => {
    beforeEach(async () => {
      await redis.set(
        stateKey,
        JSON.stringify(makeState({ phase: GamePhase.PRE_FLOP, timerEpoch: 3 })),
      );
    });

    it('조용히 넘어가지 않고 거절한다', async () => {
      // 예전에는 `return;`으로 undefined를 돌려줬고, 게이트웨이가 그걸 그대로
      // renderGame으로 브로드캐스트했다. 딜러가 진행 중에 시작 버튼을 한 번
      // 잘못 누르면 테이블 전원의 화면 상태가 undefined로 덮인다.
      await expect(dealer.startPreFlop(TOURNAMENT, TABLE)).rejects.toThrow();
    });

    it('진행 중인 타이머를 건드리지 않는다', async () => {
      // 거절하더라도 큐를 먼저 만지면 안 된다. 그 잡은 지금 액션을 기다리는
      // 플레이어의 타이머다.
      await queue.add(
        'player-timeout',
        { tableId: TABLE, userId: 'alice', timerEpoch: 3 },
        { delay: 30000, jobId: `${TABLE}-3`, removeOnComplete: true, removeOnFail: true },
      );
      const before = await queue.getJob(`${TABLE}-3`);

      await expect(dealer.startPreFlop(TOURNAMENT, TABLE)).rejects.toThrow();

      const after = await queue.getJob(`${TABLE}-3`);
      expect(after).toBeDefined();
      expect(after?.timestamp).toBe(before?.timestamp);
    });

    it('테이블 상태를 바꾸지 않는다', async () => {
      await expect(dealer.startPreFlop(TOURNAMENT, TABLE)).rejects.toThrow();

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.PRE_FLOP);
      expect(state.pot).toBe(0);
      expect(chipTotal(state)).toBe(30000);
    });
  });

  describe('승자 정산', () => {
    /** carol이 올인해서 지고 스택 0으로 남은 판. */
    function showdownState() {
      return makeState({
        phase: GamePhase.SHOWDOWN,
        pot: 1000,
        currentTurnSeatIndex: -1,
        players: [
          makePlayer('alice', 0, { totalContributed: 500 }),
          makePlayer('bob', 1),
          makePlayer('carol', 2, { stack: 0, isAllIn: true, totalContributed: 500 }),
        ],
      });
    }

    beforeEach(() => {
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(true);
      jest.spyOn(playsync, 'eliminatePlayer').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('탈락 확정과 초기화는 락 안에서 한다', async () => {
      await redis.set(stateKey, JSON.stringify(showdownState()));

      let lockHeld = -1;
      jest.spyOn(playsync, 'eliminatePlayer').mockImplementation(async () => {
        lockHeld = await redis.exists(`lock:table:state:${TABLE}`);
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      expect(lockHeld).toBe(1);
    });

    it('리바인 응답을 기다리는 동안에는 락을 놓는다', async () => {
      // 예전에는 이 대기가 통째로 락 안에 있어서 TTL을 30초로 늘려야 했다.
      // 그동안 도착하는 유저 액션과 타임아웃 잡은 전부 대기하다 실패한다.
      await seedMeta(true);
      await redis.set(stateKey, JSON.stringify(showdownState()));

      let lockDuringRebuy = -1;
      jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
        lockDuringRebuy = await redis.exists(`lock:table:state:${TABLE}`);
        return 0;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      expect(playsync.processRebuy).toHaveBeenCalledTimes(1);
      expect(lockDuringRebuy).toBe(0);
    });

    it('리바인 대기 중에는 다음 핸드가 시작되지 않는다', async () => {
      // 락을 놓는 대신 페이즈가 문지기가 된다. HAND_END면 startPreFlop이 거절한다.
      await seedMeta(true);
      await redis.set(stateKey, JSON.stringify(showdownState()));

      let phaseDuringRebuy: GamePhase | undefined;
      let startRejected = false;
      jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
        await dealer.startPreFlop(TOURNAMENT, TABLE).catch(() => { startRejected = true; });
        const mid: TableState = JSON.parse((await redis.get(stateKey))!);
        phaseDuringRebuy = mid.phase;
        return 0;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      expect(startRejected).toBe(true);
      expect(phaseDuringRebuy).toBe(GamePhase.HAND_END);
    });

    it('정산이 끝나면 WAITING으로 돌아간다', async () => {
      await redis.set(stateKey, JSON.stringify(showdownState()));

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
      expect(state.pot).toBe(0);
    });

    it('리바인으로 살아난 플레이어는 탈락시키지 않는다', async () => {
      // 3단계가 1단계의 낡은 객체를 그대로 쓰면, 대기 중 반영된 리바인 스택이
      // 보이지 않아 살아난 사람을 탈락 처리한다. 스냅샷을 다시 읽어야 한다.
      await seedMeta(true);
      await redis.set(stateKey, JSON.stringify(showdownState()));

      jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
        // 진짜 processRebuy가 하는 일: 짧게 락을 잡고 스택을 반영한다.
        await redisService.withTableLock(TABLE, async () => {
          const mid = (await redisService.getSnapShot(TABLE))!;
          new TableEngine(mid).applyRebuy('carol', 10000);
          await redisService.saveSnapShot(TABLE, mid);
        });
        return 10000;
      });

      let eliminatedIds: string[] = [];
      jest.spyOn(playsync, 'eliminatePlayer').mockImplementation(async (_t, _tb, players) => {
        eliminatedIds = players.map(p => p.id);
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      expect(eliminatedIds).toEqual([]);
      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[2]!.stack).toBe(10000);
    });
  });
});
