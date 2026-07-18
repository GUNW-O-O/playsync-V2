import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PlaysyncService } from './playsync.service';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ActionType, GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * handleAction의 동시성·순서 계약을 고정한다.
 *
 * 진짜 Redis와 진짜 BullMQ 큐를 쓴다. 검증 대상이 "낡은 타임아웃 잡이 다음
 * 플레이어의 타이머를 지우는가"이므로, 큐를 mock으로 바꾸면 검증할 대상이
 * 사라진다. 워커는 띄우지 않으므로 지연 잡은 발화하지 않고 큐에 남아 있다.
 */
describe('PlaysyncService.handleAction', () => {
  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let service: PlaysyncService;

  const TABLE = 'table-1';
  const TOURNAMENT = 'tournament-1';

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

  /** 다음 플레이어의 타이머. 낡은 액션이 이 잡을 건드리면 안 된다. */
  async function queueTimeoutFor(userId: string, timerEpoch: number) {
    await queue.add(
      'player-timeout',
      { tableId: TABLE, userId, timerEpoch },
      {
        delay: 30000,
        jobId: `${TABLE}-${timerEpoch}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  beforeAll(() => {
    redis = createTestRedis();
    // BullMQ는 블로킹 명령을 쓰므로 재시도 제한이 없는 별도 연결을 요구한다.
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });

    const redisService = new RedisService(redis);
    service = new PlaysyncService(
      queue,
      redisService,
      {} as PrismaService, // handleAction 경로는 DB를 건드리지 않는다
      new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  describe('낡은 TIME_OUT 잡', () => {
    it('이미 턴이 넘어갔으면 다음 플레이어의 타이머를 지우지 않는다', async () => {
      // alice가 액션을 마쳐 턴이 bob에게 넘어갔고, 큐에는 bob의 타이머가 있다.
      // 그 직후 alice에 대한 낡은 TIME_OUT 잡이 발화한다.
      await redis.set(
        `table:state:${TABLE}`,
        JSON.stringify(makeState({ currentTurnSeatIndex: 1, timerEpoch: 3 })),
      );
      await queueTimeoutFor('bob', 3);

      const before = await queue.getJob(`${TABLE}-3`);

      await service.handleAction('alice', TABLE, { action: ActionType.TIME_OUT });

      // 검증보다 잡 제거가 먼저 오면 bob의 타이머가 유실된다. 지우고 같은
      // 대상으로 다시 넣어도 마찬가지다 — 그 순간 bob의 30초가 처음부터 다시
      // 시작되므로, 낡은 잡 하나가 남의 제한시간을 늘려주게 된다.
      const after = await queue.getJob(`${TABLE}-3`);
      expect(after).toBeDefined();
      expect(after?.data.userId).toBe('bob');
      expect(after?.timestamp).toBe(before?.timestamp);
    });

    it('턴이 다시 돌아온 뒤 재전달돼도 새 턴을 시간 초과시키지 않는다', async () => {
      // BullMQ는 at-least-once다. 워커가 처리 후 ack 전에 죽으면 같은 잡이
      // 다시 배달된다. 그 사이 스트리트가 넘어가 턴이 alice에게 돌아왔다면,
      // "지금 alice 턴인가"만 봐서는 낡은 잡을 구별할 수 없다 — 방금 30초를
      // 받은 유저가 즉시 폴드당한다.
      //
      // 그래서 잡은 자기가 예약된 타이머 세대를 들고 다니고, 세대가 다르면
      // 스스로 폐기된다. 잡 제거 실패도 이 검사가 함께 막는다.
      await redis.set(
        `table:state:${TABLE}`,
        JSON.stringify(makeState({ currentTurnSeatIndex: 0, timerEpoch: 7 })),
      );

      const state = await service.handleAction(
        'alice',
        TABLE,
        { action: ActionType.TIME_OUT },
        5, // 낡은 세대
      );

      expect(state.players[0]!.hasFolded).toBe(false);
      expect(state.currentTurnSeatIndex).toBe(0);
    });

    it('테이블 상태를 바꾸지 않는다', async () => {
      const before = makeState({ currentTurnSeatIndex: 1, timerEpoch: 3 });
      await redis.set(`table:state:${TABLE}`, JSON.stringify(before));
      await queueTimeoutFor('bob', 3);

      await service.handleAction('alice', TABLE, { action: ActionType.TIME_OUT });

      const after = JSON.parse((await redis.get(`table:state:${TABLE}`))!);
      expect(after).toEqual(before);
    });
  });

  describe('마감 시각', () => {
    it('마감이 지난 뒤 도착한 액션은 TIME_OUT으로 처리한다', async () => {
      // 태블릿에서 늦게 누른 버튼이 30초를 넘겨 도착한 경우.
      // 도착 순서가 아니라 마감 시각이 판정 기준이다.
      await redis.set(
        `table:state:${TABLE}`,
        JSON.stringify(makeState({ actionDeadline: Date.now() - 1000 })),
      );

      const state = await service.handleAction('alice', TABLE, {
        action: ActionType.RAISE,
        amount: 1000,
      });

      const alice = state.players[0]!;
      expect(alice.hasFolded).toBe(true); // 콜 금액 미달이므로 폴드
      expect(alice.stack).toBe(10000); // 레이즈가 적용되지 않았다
      expect(state.pot).toBe(0);
    });

    it('마감 전에 도착한 액션은 정상 처리한다', async () => {
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));

      const state = await service.handleAction('alice', TABLE, {
        action: ActionType.RAISE,
        amount: 1000,
      });

      const alice = state.players[0]!;
      expect(alice.hasFolded).toBe(false);
      expect(alice.stack).toBe(9000);
      expect(state.pot).toBe(1000);
    });
  });

  describe('KICKED 유저', () => {
    it('어떤 액션을 보내든 폴드로 처리한다', async () => {
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
      await redis.hset(
        `tournament:${TOURNAMENT}:user`,
        'alice',
        JSON.stringify({ tableId: TABLE, seatIndex: 0, status: 'KICKED' }),
      );

      const state = await service.handleAction('alice', TABLE, {
        action: ActionType.RAISE,
        amount: 1000,
      });

      const alice = state.players[0]!;
      expect(alice.hasFolded).toBe(true);
      expect(alice.stack).toBe(10000); // 레이즈가 함께 적용되면 안 된다
      expect(state.pot).toBe(0);
    });
  });

  describe('테이블에 없는 유저', () => {
    it('거부한다', async () => {
      // 지금은 playerIdx === -1이 그대로 engine.act(-1)로 넘어간다.
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));

      await expect(
        service.handleAction('mallory', TABLE, { action: ActionType.FOLD }),
      ).rejects.toThrow();
    });
  });

  describe('동시 실행', () => {
    it('겹친 액션이 앞선 액션의 결과를 지우지 않는다', async () => {
      await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));

      // 턴 주인 alice의 레이즈와, 자기 턴이 아닌 carol의 액션이 겹친다.
      // carol의 액션은 엔진이 걸러내지만, 그 경로도 스냅샷을 저장한다.
      //
      // 락이 없으면 둘이 같은 스냅샷을 읽는다. carol이 나중에 저장하면서
      // 레이즈 이전 상태를 통째로 되돌려 놓고, alice의 칩 1000이 증발한다.
      // 스냅샷 자체는 정합해 보이므로 아무도 눈치채지 못한다.
      await Promise.all([
        service.handleAction('alice', TABLE, { action: ActionType.RAISE, amount: 1000 }),
        service.handleAction('carol', TABLE, { action: ActionType.RAISE, amount: 2000 }),
      ]);

      const state: TableState = JSON.parse((await redis.get(`table:state:${TABLE}`))!);
      expect(state.pot).toBe(1000);
      expect(state.players[0]!.stack).toBe(9000);
      expect(state.players[2]!.stack).toBe(10000);
    });
  });
});
