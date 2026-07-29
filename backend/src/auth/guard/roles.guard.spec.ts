import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { SEAT_ROLE } from '../seat-role';

/**
 * 좌석 토큰(T28)의 권한 범위는 화이트리스트가 아니라 **이 가드의 귀결**이다.
 * `role: 'PLAYER'`가 Prisma Role enum 밖의 값이라 어떤 `@Roles(...)` 목록과도
 * 맞지 않고, 그래서 돈·신원 라우트가 전부 자동으로 막힌다.
 *
 * 근거가 한 줄(`requiredRoles.includes(user.role)`)에 걸려 있으므로 그 줄이
 * 바뀌면 즉시 알아야 한다.
 */
describe('RolesGuard — 좌석 토큰', () => {
  function contextWith(role: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function guardRequiring(roles: Role[] | undefined) {
    const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('@Roles(USER) 라우트를 좌석 토큰으로 통과하지 못한다', () => {
    expect(guardRequiring([Role.USER]).canActivate(contextWith(SEAT_ROLE))).toBe(false);
  });

  it('@Roles(STORE_ADMIN) 라우트도 마찬가지다', () => {
    const guard = guardRequiring([Role.STORE_ADMIN, Role.PLATFORM_ADMIN]);
    expect(guard.canActivate(contextWith(SEAT_ROLE))).toBe(false);
  });

  it('역할 요구가 없는 라우트(JwtAuthGuard만)는 통과한다 — 게임 경로가 여기 있다', () => {
    expect(guardRequiring(undefined).canActivate(contextWith(SEAT_ROLE))).toBe(true);
  });

  it('진짜 USER는 여전히 통과한다', () => {
    expect(guardRequiring([Role.USER]).canActivate(contextWith(Role.USER))).toBe(true);
  });
});
