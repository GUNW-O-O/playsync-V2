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
  // OtpAttempts를 export하는 이유: Task 4의 SessionService(재발급 경로)가
  // 같은 잠금 카운터 인스턴스를 써야 한다.
  exports: [DealerService, OtpAttempts],
})
export class DealerModule {}
