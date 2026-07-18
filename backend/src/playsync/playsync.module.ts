import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PlaysyncService } from './playsync.service';
import { PlaysyncController } from './playsync.controller';
import { TimeoutProcessor } from './timeout.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name : 'player-timeout'
    }),
  ],
  controllers: [PlaysyncController],
  providers: [
    PlaysyncService,
    TimeoutProcessor
  ],
  exports: [PlaysyncService],
})
export class PlaysyncModule {}
