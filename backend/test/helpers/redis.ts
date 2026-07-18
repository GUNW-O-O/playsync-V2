import Redis from 'ioredis';
import { applyTestEnv } from './test-env';

/**
 * 테스트용 Redis 클라이언트를 만든다.
 *
 * 접속 대상은 docker-compose.test.yml이 띄운 별도 컨테이너다. 개발용과 포트가
 * 다르므로 실수로 개발 Redis를 비울 수 없다.
 */
export function createTestRedis(): Redis {
  applyTestEnv();

  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6380),
    password: process.env.REDIS_PASSWORD,
    // 테스트가 접속 실패로 조용히 매달리지 않도록 재시도를 짧게 끊는다.
    maxRetriesPerRequest: 3,
  });
}

/** 테스트 사이 상태 격리. 각 테스트는 빈 Redis에서 시작해야 한다. */
export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushall();
}
