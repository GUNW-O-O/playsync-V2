import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        return new Redis({
          host: 'localhost',
          port: 6379,
          password: process.env.REDIS_PASSWORD,
        });
      },
    },
    RedisService,
  ],
  exports: ['REDIS_CLIENT', RedisService], // 두 가지 모두 export 해야 외부에서 사용 가능
})
export class RedisModule { }