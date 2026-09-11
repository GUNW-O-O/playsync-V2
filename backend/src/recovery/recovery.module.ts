import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { RecoveryService } from './recovery.service';

// RedisModule과 PrismaModule이 둘 다 @Global이라 imports가 필요 없다.
//
// 큐는 예외다. 복구가 정지 뒤에 턴 타이머를 다시 걸어야 하고(T94), 그 잡은
// `PlaysyncService`가 거는 것과 **같은 큐**여야 한다 — 이름이 갈리면 살아남은
// 잡과 새 잡이 서로 다른 큐에 앉아 세대 검사가 무의미해진다.
@Module({
  imports: [BullModule.registerQueue({ name: 'player-timeout' })],
  providers: [HeartbeatService, RecoveryService],
})
export class RecoveryModule {}
