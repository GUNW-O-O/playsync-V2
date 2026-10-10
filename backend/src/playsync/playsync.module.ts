import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PlaysyncService } from './playsync.service';
import { PlaysyncController } from './playsync.controller';
import { TimeoutProcessor } from './timeout.processor';
import { RecoveryModule } from 'src/recovery/recovery.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name : 'player-timeout'
    }),
    // 타임아웃 워커가 부팅 복구를 기다렸다 돈다(T122).
    RecoveryModule,
  ],
  controllers: [PlaysyncController],
  providers: [
    PlaysyncService,
    TimeoutProcessor
  ],
  exports: [PlaysyncService],
})
export class PlaysyncModule {}
