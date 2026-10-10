import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { RecoveryService } from './recovery.service';

// RedisModule과 PrismaModule이 둘 다 @Global이라 imports가 필요 없다.
//
// 아래 큐 등록은 지금 이 모듈에서 쓰이지 않는다 — `RecoveryService`도
// `HeartbeatService`도 큐를 주입받지 않는다. 복구는 턴 타이머를 다시 걸지 않고
// 멈춘 채로 세운다(`RecoveryService.pauseTable`). 잡을 거는 쪽은
// `PlaysyncService`와 `DealerService`다.
@Module({
  imports: [BullModule.registerQueue({ name: 'player-timeout' })],
  providers: [HeartbeatService, RecoveryService],
  // 게이트웨이가 n/n을 본 순간 `completeSync`를 부른다(T96 Task 4).
  exports: [RecoveryService],
})
export class RecoveryModule {}
