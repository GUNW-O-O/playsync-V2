import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerOptions } from './auth/throttle';
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
    // 저장소를 따로 주지 않아 인메모리다. 대회 하나가 한 프로세스라는 이
    // 리포의 전제(B9 "하지 않는다")와 같은 자리다 — 서버를 늘리면 카운터도
    // 프로세스마다 갈라진다.
    ThrottlerModule.forRoot(throttlerOptions()),
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
  providers: [
    // 전역이라야 값이 있다. 라우트마다 붙이면 새 라우트가 조용히 빠지고,
    // 빠진 상태는 아무 신호도 내지 않는다(요청이 다 통과한다). 좁혀야 하는
    // 라우트는 `@Throttle`로 그 자리에서 덮는다.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
