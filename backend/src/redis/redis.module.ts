import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        // host/port가 하드코딩돼 있어서 .env의 REDIS_HOST/REDIS_PORT가 무시되고 있었다.
        // 통합 테스트는 별도 포트(6380)의 컨테이너를 쓰므로 환경변수를 따른다.
        return new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASSWORD,
        });
      },
    },
    RedisService,
  ],
  exports: ['REDIS_CLIENT', RedisService], // 두 가지 모두 export 해야 외부에서 사용 가능
})
export class RedisModule { }