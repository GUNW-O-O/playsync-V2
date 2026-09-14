import { JwtService } from '@nestjs/jwt';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from './dealer.service';
import { OtpAttempts } from './otp-attempts';
import { PlaysyncService, RebuyOutcome } from 'src/playsync/playsync.service';
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
      ante: 0,
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
   *
   * **`rebuyUntil`이 0이면 안 된다**(T47). 마감 판정은 `현재 레벨 < rebuyUntil`
   * 이고 구조의 첫 레벨이 `lv: 1`이라, 0이면 대회 시작 순간부터 이미 닫힌
   * 상태다 — 리바인이 열린 시나리오를 세울 수가 없다. 예전에는 해시에 박아 둔
   * `isRegistrationOpen: true`가 그대로 읽혀서 이 모순이 드러나지 않았다.
   * 지금은 대시보드가 **동기화된 레벨에서 마감을 파생**하므로 값이 서로
   * 어긋나면 파생 쪽이 이긴다.
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
      rakePercent: 0,
      entryCount: 0,
      itmCount: 1,
      // 현재 레벨(lv 1)보다 커야 등록이 열린 상태가 된다.
      rebuyUntil: 5,
      avgStack: 10000,
      tournamentName: 'T',
      entryFee: 1000,
      startStack: 10000,
      prizePool: 3000,
      prizes: [{ place: 1, percent: 100, amount: 3000 }],
    };
    await redisService.setTournamentMeta(TOURNAMENT, dashboard, blind, [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }]);
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
    /**
     * **이 스펙은 DB를 안 띄운다.** 재려는 것이 Redis 락 아래의 동시성이라
     * 진짜 DB가 있어야 의미가 생기는 자리가 없었다.
     *
     * 그런데 T77이 `handleDealerAction` 앞에 파이널 테이블 게이트를 달면서
     * 조회 둘이 생겼다. 빈 객체로는 `undefined.findUniqueOrThrow`로 죽어,
     * 여기 있던 딜러 폴드 검사 셋이 **재려던 것과 무관한 이유로** 빨간불이
     * 됐다.
     *
     * 그래서 **게이트가 통과하는 값만** 심는다 — 등록이 열려 있으면 테이블
     * 수와 무관하게 파이널 테이블이 아니다. 게이트 자체의 검증은 진짜 DB가
     * 있는 `elimination.int-spec.ts`가 한다. 여기서 그것까지 보려면 이 스펙에
     * DB를 들여야 하고, 그러면 이 파일의 존재 이유(락만 본다)가 흐려진다.
     */
    const prisma = {
      tournament: { findUniqueOrThrow: async () => ({ isRegistrationOpen: true }) },
      table: { count: async () => 1 },
    } as unknown as PrismaService;
    emitter = new EventEmitter2();
    playsync = new PlaysyncService(queue, redisService, prisma, emitter);
    dealer = new DealerService(
      queue,
      prisma,
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

    await expect(dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']])).rejects.toThrow(
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
        dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]),
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
        dealer.resolveWinners(TABLE, TOURNAMENT, [['carol']]),
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

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

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
        return 'declined' as const;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

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
        return 'declined' as const;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      expect(startRejected).toBe(true);
      expect(phaseDuringRebuy).toBe(GamePhase.HAND_END);
    });

    /**
     * **판이 멈춘 이유가 스냅샷에 있어야 한다.**
     *
     * 이 15초 동안 테이블 전원이 아무 설명 없는 정지를 봤다 — 딜러 화면은
     * 「쇼다운」 배지에 「승자 결정」이 활성인 채로 남아 다시 누르면 거절당했고,
     * 남은 좌석들은 마지막 펠트를 그대로 들고 있었다. 스냅샷 필드로 두는 이유는
     * `dbSyncStatus`와 같다 — 그 15초 안에 재접속한 단말도 같은 것을 봐야 한다.
     */
    it('리바인을 기다리는 동안 스냅샷에 그 사실이 남는다', async () => {
      await seedMeta(true);
      await redis.set(stateKey, JSON.stringify(showdownState()));

      let pendingDuringRebuy: TableState['rebuyPending'];
      jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
        const mid: TableState = JSON.parse((await redis.get(stateKey))!);
        pendingDuringRebuy = mid.rebuyPending;
        return 'declined' as const;
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      // carol이 파산자다(`showdownState`에서 스택 0, 좌석 2). 마감은 서버가
      // 정하므로 값 자체가 아니라 **미래인가**를 본다.
      expect(pendingDuringRebuy?.seatIndexes).toEqual([2]);
      expect(pendingDuringRebuy!.deadline).toBeGreaterThan(Date.now());
    });

    /**
     * **끝나면 지운다.** 남아 있으면 다음 핸드가 도는 내내 화면이 「리바인을
     * 기다립니다」를 띄운다 — 아무도 안 기다리는데.
     */
    it('리바인이 끝나면 표시가 사라진다', async () => {
      await seedMeta(true);
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest.spyOn(playsync, 'processRebuy').mockResolvedValue('declined');

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      const after: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(after.rebuyPending).toBeUndefined();
    });

    /**
     * **물어볼 사람이 없으면 표시하지 않는다.** 등록이 마감된 뒤에는 리바인
     * 자체가 없으므로(`resolveWinners`의 `isRegistrationOpen` 가드) 기다리는
     * 구간도 없다.
     */
    it('등록이 마감됐으면 표시하지 않는다', async () => {
      await seedMeta(false);
      await redis.set(stateKey, JSON.stringify(showdownState()));

      const seen: (TableState['rebuyPending'])[] = [];
      const spy = jest.spyOn(redis, 'set');

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      for (const call of spy.mock.calls) {
        if (call[0] !== stateKey) continue;
        seen.push((JSON.parse(String(call[1])) as TableState).rebuyPending);
      }
      spy.mockRestore();
      expect(seen.filter(Boolean)).toEqual([]);
    });

    it('정산이 끝나면 WAITING으로 돌아간다', async () => {
      await redis.set(stateKey, JSON.stringify(showdownState()));

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

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

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

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

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

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

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      expect(lockDuringRetry.length).toBeGreaterThan(1);
      expect(lockDuringRetry.every(held => held === 0)).toBe(true);
    });

    it('재시도가 성공하면 표시를 지우고 다음 핸드로 넘어간다', async () => {
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest
        .spyOn(playsync, 'syncTableInventoryToDb')
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
      expect(state.dbSyncStatus).toBeUndefined();
    });

    it('딜러가 실패한 체크포인트를 다시 시도할 수 있다', async () => {
      // 멈추는 것 자체는 올바른 안전 상태다. 문제는 거기서 나올 방법이 없는 것.
      await redis.set(stateKey, JSON.stringify(showdownState()));
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(false);
      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(true);
      await dealer.retryCheckpoint(TABLE);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
      expect(state.dbSyncStatus).toBeUndefined();
    });

    it('표시를 남기지 못한 실패도 다시 시도할 수 있다', async () => {
      // T62. 문지기가 `dbSyncStatus === 'FAILED'`를 요구하면, **표시를 못 남긴
      // 실패**가 막다른 골목이 된다. 표시는 `mutateSnapshot` → `withTableLock`
      // 이라 Redis가 힘들면 남길 수 없고, 그 상황이 정확히 나올 길이 필요한
      // 상황이다. 페이즈가 문지기여야 한다.
      await redis.set(stateKey, JSON.stringify(makeState({
        phase: GamePhase.HAND_END,
        currentTurnSeatIndex: -1,
        pot: 0,
        currentBet: 0,
      })));
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockResolvedValue(true);

      await dealer.retryCheckpoint(TABLE);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.phase).toBe(GamePhase.WAITING);
    });

    it('그 사이 다음 핸드가 시작됐으면 진행 중인 판을 지우지 않는다', async () => {
      // 문지기 검사와 실제 전이 사이에서 체크포인트가 **락 밖으로** 수 초 돈다.
      // 그 창에서 다음 핸드가 시작되면 `initTable`이 pot과 베팅을 0으로 밀어
      // 살아 있는 판의 칩을 없앤다. 전이 직전에 락 안에서 페이즈를 다시 봐야 한다.
      await redis.set(stateKey, JSON.stringify(makeState({
        phase: GamePhase.HAND_END,
        currentTurnSeatIndex: -1,
        pot: 0,
        currentBet: 0,
        dbSyncStatus: 'FAILED',
      })));

      // 체크포인트가 도는 동안 다른 경로가 다음 핸드를 시작한 상황.
      jest.spyOn(playsync, 'syncTableInventoryToDb').mockImplementation(async () => {
        await redis.set(stateKey, JSON.stringify(makeState({
          phase: GamePhase.PRE_FLOP,
          pot: 1000,
          players: [
            makePlayer('alice', 0, { stack: 9500, bet: 500, totalContributed: 500 }),
            makePlayer('bob', 1, { stack: 9500, bet: 500, totalContributed: 500 }),
            makePlayer('carol', 2),
          ],
        })));
        return true;
      });

      await dealer.retryCheckpoint(TABLE);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(`${state.phase} pot=${state.pot}`).toBe(`${GamePhase.PRE_FLOP} pot=1000`);
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
          await redisService.saveSnapshotUnlocked(TABLE, mid, 'table-created');
        });
        return 'applied' as const;
      });

      let eliminatedIds: string[] = [];
      jest.spyOn(playsync, 'eliminatePlayer').mockImplementation(async (_t, _tb, players) => {
        eliminatedIds = players.map(p => p.id);
      });

      await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

      expect(eliminatedIds).toEqual([]);
      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[2]!.stack).toBe(10000);
    });

    describe('장애가 리바인을 끊으면 (T100)', () => {
      async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
        const start = Date.now();
        while (!(await pred())) {
          if (Date.now() - start > ms) throw new Error('until timeout');
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      const saved = async (): Promise<TableState> => JSON.parse((await redis.get(stateKey))!);
      const outage = () => redisService.outage;
      /** 실제 끊김 없이 전이만 일으킨다(진짜 down/generation 증가) — 이 describe는 복구 스윕이 없어 진짜로 끊으면 up으로 못 돌아온다. */
      function simulateDown() {
        (outage() as unknown as { onLost(): void }).onLost();
      }

      // **공유 상태다.** `redisService.outage`는 클라이언트당 하나라 이
      // describe의 테스트들이 직접 만졌으면 다음 테스트로 새지 않게 되돌린다.
      // `whenUp` 대기자가 남아 있으면(테스트가 markRecovered 전에 실패해도)
      // 여기서 풀어 다음 테스트가 영원히 기다리지 않게 한다.
      afterEach(() => {
        const o = outage();
        if (o.phase !== 'up') {
          o.phase = 'recovering';
          o.markRecovered();
        }
        o.downSince = null;
      });

      it('재개 전에는 다시 묻지 않고, 재개하면 중단된 사람에게만 다시 묻는다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const outcomes: RebuyOutcome[] = ['interrupted', 'declined'];
        const rebuy = jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => outcomes.shift()!);

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        await until(async () => (await saved()).resumePending !== undefined);
        const paused = await saved();
        expect(`재개 전 호출 ${rebuy.mock.calls.length} 리바인표시 ${paused.rebuyPending === undefined} 페이즈 ${paused.phase}`)
          .toBe(`재개 전 호출 1 리바인표시 true 페이즈 ${GamePhase.HAND_END}`);

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`재개 뒤 호출 ${rebuy.mock.calls.length} 대상 ${rebuy.mock.calls[1]![2]}`).toBe('재개 뒤 호출 2 대상 carol');
      });

      it('중단 뒤 칩이 이미 들어가 있으면 다시 묻지 않는다 (반대 입력)', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const rebuy = jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted');

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);
        await until(async () => (await saved()).resumePending !== undefined);

        // 오프라인 큐가 늦게 실행한 칩 쓰기(검수 S6) — 재개 전에 스택이 생겼다.
        const landed = await saved();
        landed.players[2]!.stack = 10000;
        await redis.set(stateKey, JSON.stringify(landed));

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`호출 ${rebuy.mock.calls.length}`).toBe('호출 1');
      });

      it('리바인 고리가 도는 동안 체크포인트 재시도는 거절한다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        let retry: unknown = null;
        jest.spyOn(playsync, 'processRebuy').mockImplementation(async () => {
          retry = await dealer.retryCheckpoint(TABLE).then(() => 'passed', (e: Error) => e.message);
          return 'declined';
        });

        await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        expect(retry).toBe('리바인을 기다리는 중입니다.');
      });

      it('재개 대기 중에도 체크포인트 재시도는 거절한다', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted').mockResolvedValue('declined');

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);
        await until(async () => (await saved()).resumePending !== undefined);

        await expect(dealer.retryCheckpoint(TABLE)).rejects.toThrow('리바인을 기다리는 중입니다.');

        await dealer.resumeTable(TABLE);
        await settling;
      });

      /**
       * **D3 재시도 촉매 하나(검수 I1).** `askRebuyRound`의 `markRebuyPending`
       * catch는 장애가 표시를 세우기 **전에** 끊었을 때를 잡는다. 지금까지는
       * 이 catch를 지워도 모든 테스트가 초록이었다 — 아무도 `markRebuyPending`
       * 자체를 장애로 실패시키지 않았기 때문이다.
       *
       * `whenUp`이 실제로 걸리는지도 함께 본다: 복구(`markRecovered`) 전에는
       * `resumePending`도, `processRebuy` 재호출도 없어야 한다.
       */
      it('markRebuyPending이 장애로 던지면 라운드 전체가 중단으로 처리되고, 복구·재개 뒤에 다시 묻는다 (검수 I1)', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const rebuy = jest.spyOn(playsync, 'processRebuy').mockResolvedValue('declined');

        const originalMarkPending = playsync.markRebuyPending.bind(playsync);
        let failedOnce = false;
        const markPending = jest
          .spyOn(playsync, 'markRebuyPending')
          .mockImplementation(async (tid: string, ids: string[] | null) => {
            if (!failedOnce && ids !== null) {
              failedOnce = true;
              simulateDown();
              throw new Error('markRebuyPending 장애 (검수 I1)');
            }
            return originalMarkPending(tid, ids);
          });

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        await until(() => markPending.mock.calls.length >= 1);
        // 복구 전: 이 라운드는 처음부터 못 물었으니 processRebuy가 한 번도
        // 안 불렸고, 표시를 못 세웠으니 재개 대기도 아직 없다.
        expect(`복구 전 리바인호출 ${rebuy.mock.calls.length} 재개대기 ${(await saved()).resumePending === undefined}`)
          .toBe('복구 전 리바인호출 0 재개대기 true');

        outage().phase = 'recovering';
        outage().markRecovered();
        await until(async () => (await saved()).resumePending !== undefined);
        // whenUp이 진짜로 걸렸다면, 복구 직후에도 아직 dealer.resumeTable을
        // 누르지 않았으므로 라운드 2는 시작되지 않는다.
        expect(rebuy.mock.calls.length).toBe(0);
        expect((await saved()).resumePending!.downMs).toBeGreaterThan(0);

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`호출 ${rebuy.mock.calls.length} 대상 ${rebuy.mock.calls[0]![2]}`).toBe('호출 1 대상 carol');
      });

      /**
       * **D3 재시도 촉매 둘(검수 I1).** `holdForDealer`의 `markRebuyInterrupted`
       * catch는 복구 **직후 또** 끊긴 경우를 잡는다. 지우면 첫 재시도의 실패가
       * 그대로 `resolveWinners`까지 던져 올라간다.
       */
      it('markRebuyInterrupted이 장애로 던지면 up이 될 때까지 재시도하고, 복구·재개 뒤에 다시 묻는다 (검수 I1)', async () => {
        await seedMeta(true);
        await redis.set(stateKey, JSON.stringify(showdownState()));
        const rebuy = jest
          .spyOn(playsync, 'processRebuy')
          .mockResolvedValueOnce('interrupted')
          .mockResolvedValueOnce('declined');

        const originalMarkInterrupted = playsync.markRebuyInterrupted.bind(playsync);
        let failedOnce = false;
        const markInterrupted = jest
          .spyOn(playsync, 'markRebuyInterrupted')
          .mockImplementation(async (tid: string, downMs: number) => {
            if (!failedOnce) {
              failedOnce = true;
              simulateDown();
              throw new Error('markRebuyInterrupted 장애 (검수 I1)');
            }
            return originalMarkInterrupted(tid, downMs);
          });

        const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);

        await until(() => markInterrupted.mock.calls.length >= 1);
        expect(`복구 전 재시도 ${markInterrupted.mock.calls.length} 재개대기 ${(await saved()).resumePending === undefined}`)
          .toBe('복구 전 재시도 1 재개대기 true');

        outage().phase = 'recovering';
        outage().markRecovered();
        await until(async () => (await saved()).resumePending !== undefined);
        expect(markInterrupted.mock.calls.length).toBe(2);
        // whenUp이 진짜로 걸렸다면, 재개를 누르기 전까지는 라운드 2가
        // 시작되지 않아 processRebuy 호출 수가 그대로다(라운드 1의 1회뿐).
        expect(rebuy.mock.calls.length).toBe(1);
        expect((await saved()).resumePending!.downMs).toBeGreaterThan(0);

        await dealer.resumeTable(TABLE);
        await settling;

        expect(`호출 ${rebuy.mock.calls.length}`).toBe('호출 2');
      });

      describe('대회가 닫히면 (잔여 — 재개 대기가 영영 안 풀린다)', () => {
        it('재개 대기 중에 대회가 닫히면 정산이 매달리지 않고 끝난다', async () => {
          await seedMeta(true);
          await redis.set(stateKey, JSON.stringify(showdownState()));
          jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted');

          const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]);
          await until(async () => (await saved()).resumePending !== undefined);

          // SessionService.announceClosed와 같은 순서(스냅샷 삭제 → 이벤트)를
          // 흉내낸다 — 부르는 쪽 트랜잭션이 스냅샷을 이미 지운 뒤에 이벤트가 온다.
          await redis.del(stateKey);
          dealer.handleTournamentClosed({ tournamentId: TOURNAMENT, tableIds: [TABLE], status: 'CANCELLED' });

          // resolve든 reject든 상관없다 — 매달리지만 않으면 된다.
          await settling.catch(() => { /* 스냅샷이 없어 던져도 여기서는 괜찮다 */ });

          // 스냅샷이 없으니 다른 이유로 던질 수 있다 — '리바인을 기다리는
          // 중입니다.'가 아니라는 것만으로 rebuyInFlight가 지워졌다고 본다.
          await expect(dealer.retryCheckpoint(TABLE)).rejects.not.toThrow('리바인을 기다리는 중입니다.');
        });

        it('반대 입력 — 다른 테이블의 닫힘으로는 풀리지 않는다', async () => {
          await seedMeta(true);
          await redis.set(stateKey, JSON.stringify(showdownState()));
          jest.spyOn(playsync, 'processRebuy').mockResolvedValueOnce('interrupted').mockResolvedValue('declined');

          let settled = false;
          const settling = dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]).finally(() => { settled = true; });
          await until(async () => (await saved()).resumePending !== undefined);

          dealer.handleTournamentClosed({ tournamentId: TOURNAMENT, tableIds: ['다른-테이블'], status: 'CANCELLED' });

          // 「안 풀렸다」는 시간으로만 관찰할 수 있다 — 짧게 기다렸다가 아직임을 본다.
          await new Promise((r) => setTimeout(r, 300));
          expect(settled).toBe(false);

          await dealer.resumeTable(TABLE);
          await settling;
          expect(settled).toBe(true);
        });

        it('재개 대기를 걸기 전에(재개 표시 쓰기 직후) 스냅샷이 없어지면 기다리지 않고 끝낸다', async () => {
          await seedMeta(true);
          await redis.set(stateKey, JSON.stringify(showdownState()));
          jest.spyOn(playsync, 'processRebuy').mockResolvedValue('interrupted');

          // markRebuyInterrupted(재개 대기 표시를 쓰는 자리)가 원래 동작하기
          // **전에** 스냅샷을 지운다 — 대회가 닫혀 표시를 세울 자리 자체가
          // 없어진 경우를 흉내낸다. 원래 동작은 스냅샷이 없으면 조용히
          // 아무것도 안 쓴다(PlaysyncService.markRebuyInterrupted).
          const originalMarkInterrupted = playsync.markRebuyInterrupted.bind(playsync);
          jest.spyOn(playsync, 'markRebuyInterrupted').mockImplementation(async (tid: string, downMs: number) => {
            await redis.del(stateKey);
            return originalMarkInterrupted(tid, downMs);
          });

          await dealer.resolveWinners(TABLE, TOURNAMENT, [['alice']]).catch(() => { /* 스냅샷이 없어 던져도 괜찮다 */ });

          // 재개 없이 끝났다 — resumeTable을 부르지 않았는데도 여기 도달했다는
          // 것 자체가 증거다. 표시도 남지 않는다.
          await expect(dealer.retryCheckpoint(TABLE)).rejects.not.toThrow('리바인을 기다리는 중입니다.');
        });
      });
    });
  });
});
