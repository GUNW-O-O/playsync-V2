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
    const handleAction = jest.fn().mockResolvedValue(undefined);

    moduleRef = await Test.createTestingModule({
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
          useValue: { getSnapShot: async () => ({ currentTurnSeatIndex: 0, players: [{ id: 'victim' }] }) },
        },
        { provide: RecoveryService, useValue: { bootOnce: () => boot } },
      ],
    }).compile();

    // 죽어 있던 동안 마감이 지난 잡 — 지연이 없어 워커가 돌면 곧바로 집힌다.
    const queue = moduleRef.get<Queue>(getQueueToken('player-timeout'));
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
