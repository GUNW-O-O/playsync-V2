import { Module } from '@nestjs/common';
import { DealerModule } from './dealer/dealer.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './store/session/session.module';
import { UserModule } from './user/user.module';
import { PlaysyncModule } from './playsync/playsync.module';
import { BullModule } from '@nestjs/bullmq';
import { PaymentModule } from './payment/payment.module';
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { WsModule } from './ws/ws.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EntryModule } from './entry/entry.module';
import { MetricsModule } from './metrics/metrics.module';
import { RecoveryModule } from './recovery/recovery.module';

/**
 * 부하 실행 중에만 계측 모듈을 들인다.
 *
 * 제품 코드를 부하테스트를 위해 건드리는 유일한 지점이고, 그래서 조건을
 * **모듈 등록**에 뒀다 — 꺼져 있으면 라우트도 히스토그램 타이머도 존재하지
 * 않는다. 기본값이 꺼짐인 것이 T32가 걷어낸 잔재와 다른 점이다.
 */
const loadMetrics = process.env.LOAD_METRICS === '1' ? [MetricsModule] : [];

@Module({
  imports:[
    ...loadMetrics,
    BullModule.forRoot({
      connection : {
        host : process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD,
      }
    }),
    EventEmitterModule.forRoot(),
    AuthModule,
    PlaysyncModule,
    PrismaModule,
    RedisModule,
    UserModule,
    SessionModule,
    DealerModule,
    PlaysyncModule,
    PaymentModule,
    StoreModule,
    WsModule,
    EntryModule,
    RecoveryModule,
  ],
})
export class AppModule {}
