import { Module } from '@nestjs/common';
import { DealerController } from './dealer.controller';
import { DealerService } from './dealer.service';
import { OtpAttempts } from './otp-attempts';
import { PlaysyncModule } from 'src/playsync/playsync.module';
import { BullModule } from '@nestjs/bullmq';
import { RedisService } from 'src/redis/redis.service';
import { SessionModule } from 'src/store/session/session.module';

@Module({
  imports: [
    BullModule.registerQueue({
          name : 'player-timeout'
        }),
    PlaysyncModule,
    SessionModule,
  ],
  controllers: [DealerController],
  providers: [DealerService, RedisService, OtpAttempts],
  // OtpAttempts를 export하는 이유: 원래 Task 4의 SessionService(재발급 경로)가
  // 같은 잠금 카운터 인스턴스를 쓰게 하려는 의도였다. 그런데 이 모듈이 이미
  // SessionModule을 import하고 있어서(위 16번째 줄 — DealerController가
  // SessionService를 쓴다) 반대 방향으로 SessionModule이 이 모듈을 import하면
  // 순환 참조가 된다. 그래서 SessionModule은 이 export를 쓰지 않고 자기
  // providers에 OtpAttempts를 따로 둔다(session.module.ts 참고) — 상태는
  // REDIS_CLIENT(전역)에 있어 인스턴스가 둘이어도 같은 잠금 카운터를 본다.
  // 이 export는 그대로 둔다. DealerModule 안에서 조회 없이 직접 쓸 다른
  // 소비자가 생기면 여전히 유효하다.
  exports: [DealerService, OtpAttempts],
})
export class DealerModule {}
