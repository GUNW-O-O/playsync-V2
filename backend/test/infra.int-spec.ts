import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { createTestRedis, flushTestRedis } from './helpers/redis';
import { closeTestPrisma, createTestPrisma, truncateAll } from './helpers/prisma';

/**
 * 통합 테스트 인프라 자체를 검증한다.
 *
 * 이 파일이 통과해야 나머지 통합 테스트가 실패했을 때 "인프라 문제인가 코드 문제인가"를
 * 따질 필요가 없어진다.
 */
describe('통합 테스트 인프라', () => {
  let redis: Redis;
  let prisma: PrismaClient;

  beforeAll(async () => {
    redis = createTestRedis();
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await truncateAll(prisma);
  });

  describe('Redis', () => {
    it('개발용이 아닌 테스트 전용 인스턴스에 접속한다', () => {
      expect(process.env.REDIS_PORT).toBe('6380');
    });

    it('읽고 쓸 수 있다', async () => {
      await redis.set('smoke', 'ok');
      expect(await redis.get('smoke')).toBe('ok');
    });

    it('SET NX가 이미 있는 키를 덮어쓰지 않는다', async () => {
      // T2의 테이블 락이 이 원자성 위에 세워진다. mock이 아닌 진짜 Redis로
      // 검증해야 하는 이유이기도 하다.
      const first = await redis.set('lock:x', 'a', 'PX', 5000, 'NX');
      const second = await redis.set('lock:x', 'b', 'PX', 5000, 'NX');

      expect(first).toBe('OK');
      expect(second).toBeNull();
      expect(await redis.get('lock:x')).toBe('a');
    });

    it('테스트 사이에 상태가 남지 않는다', async () => {
      expect(await redis.get('smoke')).toBeNull();
    });
  });

  describe('PostgreSQL', () => {
    it('개발용이 아닌 테스트 전용 데이터베이스에 접속한다', () => {
      expect(process.env.DATABASE_URL).toContain('5433');
      expect(process.env.DATABASE_URL).toContain('playsync_test');
    });

    it('마이그레이션이 적용되어 있다', async () => {
      const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      const names = rows.map((r) => r.tablename);

      expect(names).toContain('User');
      expect(names).toContain('Tournament');
    });

    it('읽고 쓸 수 있다', async () => {
      await prisma.user.create({
        data: { nickname: 'smoke', password: 'hashed', points: 100 },
      });

      const found = await prisma.user.findUnique({ where: { nickname: 'smoke' } });
      expect(found?.points).toBe(100);
    });

    it('테스트 사이에 상태가 남지 않는다', async () => {
      expect(await prisma.user.count()).toBe(0);
    });
  });
});
