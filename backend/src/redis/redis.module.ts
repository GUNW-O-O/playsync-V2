import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

/**
 * Redis 접속 설정. **한 곳에서 읽는다** — 게임 상태의 클라이언트와 BullMQ
 * (`app.module.ts`)가 같은 서버를 봐야 하고, 기본값이 한쪽에만 있으면 env가 빠진
 * 날 둘이 갈라진다(T129).
 */
export function redisConnection() {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
  };
}

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        // host/port가 하드코딩돼 있어서 .env의 REDIS_HOST/REDIS_PORT가 무시되고 있었다.
        // 통합 테스트는 별도 포트(6380)의 컨테이너를 쓰므로 환경변수를 따른다.
        return new Redis(redisConnection());
      },
    },
    RedisService,
  ],
  exports: ['REDIS_CLIENT', RedisService], // 두 가지 모두 export 해야 외부에서 사용 가능
})
export class RedisModule { }