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

  async function seedBlind() {
    const blind: BlindField = {
      isBreak: false,
      startedAt: Date.now(),
      currentBlindLv: 0,
      nextLevelAt: Date.now() + 600000,
      serverTime: Date.now(),
      blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
    };
    await redisService.setTournamentBlind(TOURNAMENT, blind);
  }

  async function seedDashboard() {
    const dashboard: Dashboard = {
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
    await redisService.setTournamentDashboard(TOURNAMENT, dashboard);
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
    await seedBlind();
    await seedDashboard();
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
    await Promise.all([
      dealer.startPreFlop(TOURNAMENT, TABLE),
      dealer.startPreFlop(TOURNAMENT, TABLE),
    ]);

    const state: TableState = JSON.parse((await redis.get(stateKey))!);

    // 직렬화되면 두 번째 호출은 phase가 이미 WAITING이 아니라 그대로 반환된다.
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(state.pot).toBe(300); // SB 100 + BB 200
    expect(chipTotal(state)).toBe(30000);
  });

  it('시작할 수 없는 상태면 진행 중인 타이머를 건드리지 않는다', async () => {
    // 이미 핸드가 진행 중인데 딜러가 시작 버튼을 또 누른 경우.
    // startPreFlop은 phase를 확인하기도 전에 큐 잡부터 지운다 — 그 잡은
    // 지금 액션을 기다리는 플레이어의 타이머다.
    await redis.set(
      stateKey,
      JSON.stringify(makeState({ phase: GamePhase.PRE_FLOP, timerEpoch: 3 })),
    );
    await queue.add(
      'player-timeout',
      { tableId: TABLE, userId: 'alice', timerEpoch: 3 },
      { delay: 30000, jobId: `${TABLE}-3`, removeOnComplete: true, removeOnFail: true },
    );
    const before = await queue.getJob(`${TABLE}-3`);

    await dealer.startPreFlop(TOURNAMENT, TABLE);

    const after = await queue.getJob(`${TABLE}-3`);
    expect(after).toBeDefined();
    expect(after?.timestamp).toBe(before?.timestamp);
  });

  it('승자 정산 중에는 테이블 락을 쥐고 있다', async () => {
    // 정산은 리바인 응답을 최대 15초 기다리므로 TTL이 넉넉해야 한다.
    // 이 구간에 유저 액션이 끼어들면 팟 분배와 스택 동기화가 어긋난다.
    await redis.set(stateKey, JSON.stringify(makeState({ phase: GamePhase.SHOWDOWN, pot: 1000 })));

    let lockTtlDuringResolve = -1;
    jest
      .spyOn(playsync, 'syncTableInventoryToDb')
      .mockImplementation(async () => {
        lockTtlDuringResolve = await redis.pttl(`lock:table:state:${TABLE}`);
        return true;
      });
    jest.spyOn(playsync, 'eliminatePlayer').mockResolvedValue(undefined);

    await dealer.resolveWinners(TABLE, TOURNAMENT, ['alice']);

    // 기본 TTL(5초)로는 리바인 대기를 못 버틴다.
    expect(lockTtlDuringResolve).toBeGreaterThan(5000);
  });
});
