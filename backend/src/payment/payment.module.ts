import { Module } from '@nestjs/common';
import { SessionModule } from 'src/store/session/session.module';
import { UserModule } from 'src/user/user.module';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { MockPaymentController } from './mock-payment.controller';
import { mockPaymentEnabled } from './mock-approval';

/**
 * 목업 충전 라우트는 **설정이 켜야 존재한다**(T72).
 *
 * 요청 시점 가드가 아니라 등록 시점에 가른다 — 가드로 두면 라우트는 살아
 * 있고 판정만 붙는 것이라, 가드 하나가 잘못 걸리는 순간 **포인트를 늘리는
 * 경로**가 열린다. 등록 자체를 안 하면 설정이 곧 방어다.
 *
 * `app.module.ts`의 `LOAD_METRICS`가 이미 같은 모양이다.
 */
const mockPayment = mockPaymentEnabled() ? [MockPaymentController] : [];

@Module({
  imports: [
    UserModule,
    SessionModule,
  ],
  providers: [PaymentService],
  exports : [PaymentService],
  controllers: [PaymentController, ...mockPayment]
})
export class PaymentModule { }
