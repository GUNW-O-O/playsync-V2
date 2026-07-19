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
  let emitter: EventEmitter2;

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

    // 재시도 간격을 줄여 테스트가 실제 백오프를 기다리지 않게 한다.
    process.env.DB_SYNC_RETRY_ATTEMPTS = '3';
    process.env.DB_SYNC_RETRY_BASE_MS = '5';

    redisService = new RedisService(redis);
    const prisma = {} as PrismaService;
    emitter = new EventEmitter2();
    playsync = new PlaysyncService(queue, redisService, prisma, emitter);
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

  it('딜러가 현재 턴인 플레이어를 폴드시키면 실제로 폴드된다', async () => {
    // 자리를 비운 사람을 건너뛰라고 만든 기능인데, 정작 그 사람 차례일 때
    // 엔진이 아무 일도 하지 않았다. 딜러 화면에서는 턴이 넘어가 성공처럼 보인다.
    await redis.set(stateKey, JSON.stringify(makeState({ currentTurnSeatIndex: 0 })));

    await dealer.handleDealerAction(TOURNAMENT, TABLE, 'alice', 'FOLD');

    const state: TableState = JSON.parse((await redis.get(stateKey))!);
    expect(state.players[0]!.hasFolded).toBe(true);
    expect(chipTotal(state)).toBe(30000);
  });

  it('쇼다운 전에는 정산을 거부한다', async () => {
    // 페이즈 게이팅이 딜러 콘솔 UI에만 있었다. 같은 망의 단말이 WS를 직접
    // 열면 플랍에서도 승자를 확정할 수 있다.
    await redis.set(stateKey, JSON.stringify(makeState({ phase: GamePhase.FLOP, pot: 1000 })));

    await expect(dealer.resolveWinners(TABLE, TOURNAMENT, ['alice'])).rejects.toThrow(
      '쇼다운 상태가 아닙니다.',
    );

    const state: TableState = JSON.parse((await redis.get(stateKey))!);
    expect(state.phase).toBe(GamePhase.FLOP);
    expect(state.pot).toBe(1000);
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

  describe('실패 원인 구분', () => {
    // T11. 딜러 경로의 실패는 HTTP 상태코드가 아니라 **메시지**로 나간다
    // (`{ event: 'error', data: e.message }`). 그런데 스냅샷 없음과 토너먼트
    // 정보 없음이 똑같이 '예기치 못한 오류가 발생했습니다.'였다.
    //
    // 이 둘은 딜러가 할 일이 다르다. 스냅샷이 없으면 이 테이블은 더 진행할 수
    // 없어 운영자를 불러야 하고, 토너먼트 정보가 없으면 대회 자체의 문제다.
    // 같은 문자열이면 딜러는 그냥 다시 누르고, 로그에도 구분이 남지 않는다.

    it('스냅샷이 없으면 테이블 상태 문제라고 알린다', async () => {
      await redis.del(stateKey);

      await expect(
        dealer.handleDealerAction(TOURNAMENT, TABLE, 'alice', 'FOLD'),
      ).rejects.toThrow(/테이블 상태/);
    });

    it('토너먼트 정보가 없으면 스냅샷 문제와 다르게 알린다', async () => {
      await flushTestRedis(redis); // 대시보드까지 지운다
      await redis.set(stateKey, JSON.stringify(makeState({ phase: GamePhase.SHOWDOWN })));

      await expect(
        dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']),
      ).rejects.toThrow(/토너먼트 정보/);
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

    it('지명되지 않은 팟이 있으면 스냅샷을 건드리지 않고 거절한다', async () => {
      // T15. 엔진이 던지는 것과, 그 예외가 저장 전에 나가는 것은 다른 문제다.
      // 스냅샷이 이미 저장된 뒤라면 딜러가 다시 찍을 상태 자체가 사라진다.
      const state = makeState({
        phase: GamePhase.SHOWDOWN,
        pot: 700,
        currentTurnSeatIndex: -1,
        players: [
          makePlayer('alice', 0, { totalContributed: 300 }),
          makePlayer('bob', 1, { totalContributed: 300 }),
          makePlayer('carol', 2, { stack: 0, isAllIn: true, totalContributed: 100 }),
        ],
      });
      await redis.set(stateKey, JSON.stringify(state));
      const before = chipTotal(state);

      await expect(
        dealer.resolveWinners(TABLE, TOURNAMENT, ['carol']),
      ).rejects.toThrow(/지명되지 않은 팟/);

      const saved: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(saved.phase).toBe(GamePhase.SHOWDOWN);
      expect(saved.pot).toBe(700);
      expect(chipTotal(saved)).toBe(before);
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

    it('체크포인트가 실패하면 다음 핸드로 넘어가지 않는다', async () => {
      // 핸드 경계에서 진실의 원천이 교대한다. DB 트랜잭션이 성공한 시점까지는
      // DB가 원천이고, initTable이 WAITING으로 넘기는 순간부터 Redis 스냅샷이
      // 원천이다. 체크포인트가 안 찍혔는데 넘기면 복구 지점이 한 핸드 뒤로
      // 남는다 — 카드가 실물이라 되돌릴 근거가 테이블 위에 없다.
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(false);

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.HAND_END);
    });

    it('체크포인트 실패가 테이블 전원에게 전파된다', async () => {
      // 딜러만 아는 것으로는 부족하다. 플레이어 태블릿에도 "다음 진행에 문제가
      // 있다"가 보여야 한다. 재접속한 단말도 같은 것을 봐야 하므로 별도
      // 이벤트가 아니라 스냅샷의 필드로 둔다.
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(false);

      const broadcasts: TableState[] = [];
      emitter.on('game.state.updated', (p: { state: TableState }) => broadcasts.push(p.state));

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.dbSyncStatus).toBe('FAILED');
      expect(broadcasts.some(s => s.dbSyncStatus === 'RETRYING')).toBe(true);
    });

    it('체크포인트 재시도는 락 밖에서 한다', async () => {
      // 재시도는 백오프 때문에 수 초가 될 수 있고 락 TTL은 5초다. 락 안에 두면
      // TTL이 먼저 만료돼 남이 잡은 락을 해제하게 된다.
      await redis.set(stateKey, JSON.stringify(showdownState()));

      const lockDuringRetry: number[] = [];
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockImplementation(async () => {
        lockDuringRetry.push(await redis.exists(`lock:table:state:${TABLE}`));
        return false;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      expect(lockDuringRetry.length).toBeGreaterThan(1);
      expect(lockDuringRetry.every(held => held === 0)).toBe(true);
    });

    it('재시도가 성공하면 표시를 지우고 다음 핸드로 넘어간다', async () => {
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest
        .spyOn(playsync, 'syncTableInventoryToDb')
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);

      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
      expect(state.dbSyncStatus).toBeUndefined();
    });

    it('딜러가 실패한 체크포인트를 다시 시도할 수 있다', async () => {
      // 멈추는 것 자체는 올바른 안전 상태다. 문제는 거기서 나올 방법이 없는 것.
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(false);
      await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(true);
      await dealer.retryCheckpoint(TABLE);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
      expect(state.dbSyncStatus).toBeUndefined();
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
