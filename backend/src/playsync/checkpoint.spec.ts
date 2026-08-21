import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PlaysyncService } from './playsync.service';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * T62 — 체크포인트가 "실패했다"를 값으로만 돌려주는지.
 *
 * 인프라를 띄우지 않는다. 검증 대상이 "Redis가 죽어서 표시를 못 남기는
 * 상황"이라, 살아 있는 Redis로는 그 상황을 만들 수 없기 때문이다. 그래서
 * `mutateSnapshot`이 던지는 것 자체를 입력으로 준다.
 */
describe('PlaysyncService.checkpointTableToDb — 표시를 못 남기는 경우', () => {
  const TABLE = 'table-1';

  let attempts: string | undefined;
  let baseMs: string | undefined;

  beforeAll(() => {
    attempts = process.env.DB_SYNC_RETRY_ATTEMPTS;
    baseMs = process.env.DB_SYNC_RETRY_BASE_MS;
    process.env.DB_SYNC_RETRY_ATTEMPTS = '2';
    process.env.DB_SYNC_RETRY_BASE_MS = '1';
  });

  afterAll(() => {
    if (attempts === undefined) delete process.env.DB_SYNC_RETRY_ATTEMPTS;
    else process.env.DB_SYNC_RETRY_ATTEMPTS = attempts;
    if (baseMs === undefined) delete process.env.DB_SYNC_RETRY_BASE_MS;
    else process.env.DB_SYNC_RETRY_BASE_MS = baseMs;
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => { });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { });
  });

  afterEach(() => jest.restoreAllMocks());

  function makeService(redis: Partial<RedisService>) {
    return new PlaysyncService(
      {} as Queue,
      redis as RedisService,
      {} as PrismaService,
      new EventEmitter2(),
    );
  }

  it('markDbSyncStatus가 던져도 false를 돌려준다', async () => {
    // DB가 흔들려 재시도에 들어간 상황이면 Redis도 함께 힘든 경우가 많다.
    // 그때 표시를 남기려다 던지면, 호출자(`resolveWinners` 4단계)는 `false`가
    // 아니라 예외를 받아 테이블이 HAND_END에 표시 없이 갇힌다.
    const service = makeService({
      getSnapShot: jest.fn().mockResolvedValue(null),
      mutateSnapshot: jest.fn().mockRejectedValue(new Error('락 획득 실패')),
    });

    const ok = await service.checkpointTableToDb(TABLE);

    expect(`체크포인트 ${ok ? '성공' : '실패'}`).toBe('체크포인트 실패');
  });
});
