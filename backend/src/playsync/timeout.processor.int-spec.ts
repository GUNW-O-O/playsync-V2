import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { RedisService } from 'src/redis/redis.service';
import { RecoveryService } from 'src/recovery/recovery.service';
import { ActionType } from 'src/game-engine/types';
import { PlaysyncService } from './playsync.service';
import { TimeoutProcessor } from './timeout.processor';

type Opts = {
  boot?: Promise<void>;
  confirm?: (tableId: string) => Promise<boolean>;
  snapshot?: object;
  snapshotFor?: (tableId: string) => object;
};

/** 진짜 큐와 진짜 워커. `init()`은 부르는 쪽이 한다 — T122는 그 순간을 붙잡는다. */
async function build(opts: Opts = {}) {
  const handleAction = jest.fn().mockResolvedValue(undefined);
  const snapshot = opts.snapshot ?? { currentTurnSeatIndex: 0, players: [{ id: 'victim' }], timerEpoch: 3 };
  const moduleRef = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({
        connection: {
          host: process.env.REDIS_HOST,
          port: Number(process.env.REDIS_PORT),
          password: process.env.REDIS_PASSWORD,
        },
      }),
      BullModule.registerQueue({ name: 'player-timeout' }),
    ],
    providers: [
      TimeoutProcessor,
      { provide: PlaysyncService, useValue: { handleAction } },
      {
        provide: RedisService,
        useValue: {
          getSnapShot: async (tableId: string) => (opts.snapshotFor ? opts.snapshotFor(tableId) : snapshot),
          dealerLiveness: { confirm: opts.confirm ?? (async () => true) },
        },
      },
      { provide: RecoveryService, useValue: { bootOnce: () => opts.boot ?? Promise.resolve() } },
    ],
  }).compile();
  const queue = moduleRef.get<Queue>(getQueueToken('player-timeout'));
  return { moduleRef, queue, handleAction };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 운영과 같은 옵션 — `removeOnComplete`가 없으면 끝난 잡이 남아 「사라졌다」를 못 기다린다. */
const jobOpts = (jobId: string) => ({ jobId, removeOnComplete: true, removeOnFail: true });

/**
 * T122 — **타임아웃 워커는 부팅 복구가 끝나야 돈다.**
 *
 * 워커는 `onModuleInit`에서 서고(`BullRegistrar`) 기본값이 곧바로 도는 것이라, 부팅
 * 복구(`RecoveryService.recoverAll`)가 테이블을 멈춰 세우기 전에 죽어 있던 동안 마감이
 * 지난 잡을 집어 사람을 접었다 — 667테이블 kill에서 118건.
 *
 * 순서는 부팅 복구를 붙잡아 강제한다. 진짜 큐와 진짜 워커라야 「언제 돌기 시작하나」를
 * 본다 — 그것이 Nest의 배선이라 모듈을 통째로 세운다.
 */
describe('TimeoutProcessor — 부팅 복구가 끝나야 돈다 (T122)', () => {
  let redis: Redis;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    redis = createTestRedis();
    await flushTestRedis(redis);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await redis.quit();
  });

  it('부팅 복구가 도는 동안에는 마감이 지난 잡을 집지 않고, 끝나면 집는다', async () => {
    let releaseBoot!: () => void;
    const boot = new Promise<void>((resolve) => { releaseBoot = resolve; });
    const built = await build({ boot });
    moduleRef = built.moduleRef;
    const { queue, handleAction } = built;

    // 죽어 있던 동안 마감이 지난 잡 — 지연이 없어 워커가 돌면 곧바로 집힌다.
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 });

    const booted = moduleRef.init();
    // 워커가 돌고 있다면 잡을 집고도 남는 시간이다(고치기 전에는 여기서 1이다).
    await new Promise((r) => setTimeout(r, 1_500));
    expect(`복구 중 handleAction ${handleAction.mock.calls.length}번`).toBe('복구 중 handleAction 0번');

    releaseBoot();
    await booted;
    // 반대쪽 — 「언제나 안 돈다」가 통과하지 못하게 한다.
    const deadline = Date.now() + 10_000;
    while (handleAction.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(`복구 뒤 handleAction ${handleAction.mock.calls.length}번`).toBe('복구 뒤 handleAction 1번');
    expect(handleAction).toHaveBeenCalledWith('victim', 'table', { action: ActionType.TIME_OUT }, 3);
  });
});

describe('TimeoutProcessor — 접기 직전에 딜러를 확인한다 (T130)', () => {
  let current: { moduleRef: TestingModule; queue: Queue } | undefined;
  /** 남은 지연 잡이 다음 테스트의 무대 위에서 돈다 — 큐째 지우고 닫는다. */
  afterEach(async () => {
    await current?.queue.obliterate({ force: true });
    await current?.moduleRef.close();
    current = undefined;
  });
  const build2 = async (opts: Opts) => {
    const built = await build(opts);
    current = built;
    await built.moduleRef.init();
    return built;
  };

  /**
   * 딜러 태블릿만 꺼졌거나 회선이 끊겼다 — 그 테이블의 딜러가 답하지 않는다. 접지 않고
   * 같은 잡을 미뤄 다시 묻는다. 딜러가 돌아오면 그때 접는다.
   */
  it('딜러가 답하지 않으면 접지 않고 미뤘다가, 답하면 접는다', async () => {
    let alive = false;
    const asked: string[] = [];
    const { queue, handleAction } = await build2({
      confirm: async (tableId: string) => { asked.push(tableId); return alive; },
    });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, jobOpts('table-3'));

    await until(() => asked.length >= 1);
    // 확인 뒤 잡이 같은 id로 지연 상태로 돌아갔다 — 플레이어가 누르면 `removeTimeoutJob`이 그 id로 지운다.
    await until(async () => (await queue.getJob('table-3'))?.isDelayed() ?? false);
    expect(`답없음 handleAction ${handleAction.mock.calls.length}번`).toBe('답없음 handleAction 0번');

    alive = true;
    await until(() => handleAction.mock.calls.length === 1, 10_000);
    expect(`물은 테이블 ${asked[0]} 두번이상 ${asked.length >= 2}`).toBe('물은 테이블 table 두번이상 true');
  });

  /** 반대 입력 — 「언제나 미룬다」가 위의 앞 절반을 통과한다. */
  it('딜러가 답하면 곧바로 접는다', async () => {
    const { queue, handleAction } = await build2({ confirm: async () => true });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, jobOpts('table-3'));
    await until(() => handleAction.mock.calls.length === 1);
    expect(handleAction).toHaveBeenCalledWith('victim', 'table', { action: ActionType.TIME_OUT }, 3);
  });

  /**
   * 미뤄 둔 사이 차례가 넘어갔다(세대가 올랐다). 그 잡은 낡았다 — 딜러에게 묻지도,
   * 다시 미루지도 않고 끝나야 한다. 안 그러면 딜러가 안 돌아오는 동안 영영 돈다.
   */
  it('세대가 낡은 잡은 묻지 않고 끝난다', async () => {
    const asked: string[] = [];
    const { queue, handleAction } = await build2({
      confirm: async (t: string) => { asked.push(t); return false; },
      snapshot: { currentTurnSeatIndex: 0, players: [{ id: 'victim' }], timerEpoch: 4 },
    });
    await queue.add('timeout', { tableId: 'table', userId: 'victim', timerEpoch: 3 }, jobOpts('table-3'));
    await until(async () => (await queue.getJob('table-3')) === undefined);
    expect(`물음 ${asked.length} handleAction ${handleAction.mock.calls.length}`).toBe('물음 0 handleAction 0');
  });

  it('딜러가 꺼진 테이블만 서고 다른 테이블은 접힌다', async () => {
    const { queue, handleAction } = await build2({
      confirm: async (t: string) => t !== 'dead',
      snapshotFor: (tableId: string) => ({ currentTurnSeatIndex: 0, players: [{ id: `${tableId}-p` }], timerEpoch: 3 }),
    });
    await queue.add('timeout', { tableId: 'dead', userId: 'dead-p', timerEpoch: 3 }, jobOpts('dead-3'));
    await queue.add('timeout', { tableId: 'alive', userId: 'alive-p', timerEpoch: 3 }, jobOpts('alive-3'));
    await until(() => handleAction.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(`접힌 테이블 ${handleAction.mock.calls.map((c) => c[1]).join(',')}`).toBe('접힌 테이블 alive');
  });
});
