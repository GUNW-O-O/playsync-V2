import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { RecoveryService } from './recovery.service';

// RedisModule과 PrismaModule이 둘 다 @Global이라 imports가 필요 없다.
@Module({ providers: [HeartbeatService, RecoveryService] })
export class RecoveryModule {}
