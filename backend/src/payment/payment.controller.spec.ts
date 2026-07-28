import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { PaymentController } from './payment.controller';

/**
 * 대회 참가(바이인)는 플레이어(USER) 전용이다.
 *
 * `JwtAuthGuard`만으로는 STORE_ADMIN 같은 다른 역할의 유효한 토큰도 통과한다.
 * 그 상태로 참가비를 내고 `playerOtp`를 발급받으면, `GET
 * /user/me/participations`가 `@Roles(Role.USER)`로 막혀 있어 그 OTP를 다시
 * 읽을 방법이 없다(재발급 엔드포인트도 없다). `@Roles(Role.USER)`가 그 역할을
 * 라우트 단계에서 먼저 막는다.
 *
 * `session.controller.spec.ts`·`user.controller.spec.ts`와 같은 이유로 HTTP
 * 앱을 띄우지 않는다 — 권한 판정은 리플렉션 메타데이터 + `RolesGuard` 로직만
 * 으로 끝난다.
 */
describe('PaymentController — 참가(바이인) 권한', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => PaymentController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('payment', () => {
    const handler = PaymentController.prototype.joinSession;

    it('USER는 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.USER))).toBe(true);
    });

    it('STORE_ADMIN은 거부된다 — 발급받은 OTP를 다시 읽을 방법이 없어진다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(false);
    });

    it('PLATFORM_ADMIN도 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER도 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });

  it('건드리지 않은 다른 라우트(getTournamentInfo)는 여전히 권한 메타데이터가 없다', () => {
    // 이 라우트들은 원래도 가드가 없는 공개 조회다 — @Roles를 얹지 않았다는
    // 것을, 아무 역할도 요구하지 않는다는 사실로 확인한다.
    const handler = PaymentController.prototype.getTournamentInfo;

    expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(true);
  });
});
