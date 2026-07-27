import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { UserModule } from 'src/user/user.module';
import { OtpAttempts } from 'src/dealer/otp-attempts';

@Module({
  imports: [UserModule],
  controllers: [SessionController],
  // OtpAttempts는 DealerModule도 provider로 갖고 있다(로그인 실패 카운터).
  // 거기서 export까지 해 뒀지만 여기서 import할 수는 없다 — DealerModule이
  // 이미 SessionModule을 import하므로(DealerController가 SessionService를
  // 쓴다) 반대 방향으로 다시 import하면 모듈 순환 참조가 된다.
  //
  // 그래서 여기 별도로 둔다. 문제 없는 이유: OtpAttempts는 상태를 인스턴스
  // 필드가 아니라 REDIS_CLIENT(전역)에 들고 있어서, 두 모듈이 각자 인스턴스를
  // 만들어도 같은 잠금 카운터를 본다 — dealer.module.ts가 RedisService를
  // providers에 다시 올리는 것과 같은 방식이다.
  providers: [SessionService, OtpAttempts],
  exports: [SessionService],
})
export class SessionModule {}
