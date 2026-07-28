import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { UserController } from './user.controller';

/**
 * 마이페이지 참여 목록은 플레이어(USER) 전용이다.
 *
 * `JwtStrategy.validate`는 딜러 토큰에 `userId`를 넣지 않는다(`id`뿐이다).
 * `JwtAuthGuard`만 있으면 유효한 딜러 토큰도 이 라우트를 통과해
 * `req.user.userId`가 `undefined`가 되고, `UserService.getMyParticipations`의
 * `where: { userId: undefined }`가 필터를 통째로 지워 대회 전체의 평문 OTP가
 * 새어 나간다. `@Roles(Role.USER)`가 그 토큰을 라우트 단계에서 먼저 막는다.
 *
 * `session.controller.spec.ts`와 같은 이유로 HTTP 앱을 띄우지 않는다 — 권한
 * 판정은 리플렉션 메타데이터 + `RolesGuard` 로직만으로 끝난다.
 */
describe('UserController — 마이페이지 권한', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => UserController,
      switchToHttp: () => ({
        // 딜러 신원 모양을 그대로 흉내낸다 — userId가 없고 role만 있다.
        getRequest: () => ({ user: { role } }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('me/participations', () => {
    const handler = UserController.prototype.getMyParticipations;

    it('USER는 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.USER))).toBe(true);
    });

    it('DEALER는 거부된다 — userId 없는 토큰으로 전체 조회를 뚫지 못하게 한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });

    it('STORE_ADMIN도 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(false);
    });

    it('PLATFORM_ADMIN도 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });
  });
});
