import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 테이블 락은 진짜 Redis로만 검증할 수 있다.
 *
 * 검증 대상이 SET NX의 원자성 자체이므로, mock으로 바꾸면 테스트가 증명하려는
 * 성질이 사라진다.
 */
describe('RedisService.withTableLock', () => {
  let redis: Redis;
  let service: RedisService;

  const TABLE = 'table-1';
  const lockKey = (tableId: string) => `lock:table:state:${tableId}`;

  beforeAll(() => {
    redis = createTestRedis();
    service = new RedisService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  it('fn의 반환값을 그대로 돌려준다', async () => {
    const result = await service.withTableLock(TABLE, async () => 'done');

    expect(result).toBe('done');
  });

  it('같은 테이블에서는 한 번에 하나만 실행된다', async () => {
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      service.withTableLock(TABLE, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 150));
        running--;
      });

    await Promise.all([task(), task(), task()]);

    expect(maxRunning).toBe(1);
  });

  it('다른 테이블은 서로 막지 않는다', async () => {
    // 테이블 단위 락이므로 10테이블 토너먼트가 1테이블 속도로 떨어지면 안 된다.
    let running = 0;
    let maxRunning = 0;

    const task = (tableId: string) =>
      service.withTableLock(tableId, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 150));
        running--;
      });

    await Promise.all([task('table-a'), task('table-b')]);

    expect(maxRunning).toBe(2);
  });

  it('fn이 예외를 던져도 락을 해제한다', async () => {
    await expect(
      service.withTableLock(TABLE, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await redis.get(lockKey(TABLE))).toBeNull();
  });

  it('TTL이 만료된 뒤에는 다른 요청이 잡은 락을 해제하지 않는다', async () => {
    // TTL 100ms짜리 락을 쥐고 300ms 일한다 = 도중에 만료된다.
    const holder = service.withTableLock(
      TABLE,
      async () => {
        await new Promise((r) => setTimeout(r, 300));
      },
      100,
    );

    // 만료된 뒤 다른 요청이 같은 키를 잡는다.
    await new Promise((r) => setTimeout(r, 150));
    await redis.set(lockKey(TABLE), 'other-owner', 'PX', 5000);

    await holder;

    // 토큰 비교 없이 del을 부르면 여기서 null이 되고, 두 요청이 동시에
    // 임계 구역에 들어간 채로 아무도 눈치채지 못한다.
    expect(await redis.get(lockKey(TABLE))).toBe('other-owner');
  });

  it('대기 시간 안에 락을 못 잡으면 실패한다', async () => {
    const holder = service.withTableLock(
      TABLE,
      async () => {
        await new Promise((r) => setTimeout(r, 500));
      },
      5000,
    );

    await expect(
      service.withTableLock(TABLE, async () => 'never', 5000, 200),
    ).rejects.toThrow(/락/);

    await holder;
  });
});
