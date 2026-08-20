// 이 스펙은 Nest 부트스트랩(main.ts)을 거치지 않고 컨트롤러를 직접 로드한다.
// `seat-release.dto.spec.ts`와 같은 이유로 reflect-metadata를 먼저 불러온다 —
// 아래 `create의 body 파라미터가 검증 가능한 타입이다`가 읽는
// `design:paramtypes` 메타데이터는 이 import가 있어야 존재한다.
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { CreateSessionBody } from 'shared/dto/create-session-body.dto';
import { SessionController } from './session.controller';

it('create의 body 파라미터가 검증 가능한 타입이다', () => {
  // ValidationPipe는 **파라미터의 메타타입**으로 검증할 DTO를 고른다. `any`면
  // 고를 것이 없어 CreateSessionBody(그리고 그 안의 CreateTournamentDto ·
  // CreateBlindStructureDto)의 규칙이 하나도 안 돈다. `dto`·`blindStructure`를
  // 봉투 하나로 받는 이유는 `CreateSessionBody`의 주석 참고(C-1).
  const types = Reflect.getMetadata('design:paramtypes', SessionController.prototype, 'create');
  expect(types[1]).toBe(CreateSessionBody);
});

/**
 * 재발급/내보내기는 STORE_ADMIN 전용이다.
 *
 * 컨트롤러 클래스 레벨의 `@Roles(STORE_ADMIN, PLATFORM_ADMIN)`는 그대로
 * 두되, 이 두 엔드포인트에만 메서드 레벨 `@Roles(STORE_ADMIN)`을 얹었다 —
 * 재발급이 평문 OTP를 응답에 실어 돌려주는 돈 경로라 PLATFORM_ADMIN까지
 * 우회 길을 늘리지 않기 위해서다(리뷰 재정).
 *
 * `RolesGuard`는 `Reflector.getAllAndOverride`로 핸들러 메타데이터를 먼저
 * 보고, 있으면 클래스 메타데이터를 보지 않는다 — 그래서 메서드 레벨이
 * 클래스 레벨을 "병합"이 아니라 "완전히 덮어쓴다." 이 테스트는 실제
 * `SessionController` 메서드에 붙은 데코레이터와 진짜 `RolesGuard`를 함께
 * 돌려서 그 덮어쓰기가 실제로 일어나는지 확인한다. HTTP 앱을 띄우지 않아도
 * 되는 이유는 권한 판정이 리플렉션 메타데이터 + 가드 로직만으로 끝나기
 * 때문이다 — 이 코드베이스에는 컨트롤러 HTTP 테스트 관행 자체가 없다
 * (dealer.controller.ts도 마찬가지, Task 3 progress 메모 참고).
 */
describe('SessionController — 재발급/내보내기 권한', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => SessionController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as unknown as ExecutionContext;
  }

  describe('재발급 (dealer-otp/reissue)', () => {
    const handler = SessionController.prototype.reissueDealerOtp;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다 — 클래스 레벨 권한을 메서드 레벨이 덮어쓴다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });

  describe('내보내기 (dealer-session/revoke)', () => {
    const handler = SessionController.prototype.revokeDealerSession;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다 — 클래스 레벨 권한을 메서드 레벨이 덮어쓴다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });

  it('건드리지 않은 다른 라우트(create)는 여전히 PLATFORM_ADMIN을 허용한다', () => {
    // 메서드 레벨 @Roles가 없는 핸들러는 getAllAndOverride가 클래스
    // 레벨로 떨어져야 한다 — 이 두 엔드포인트만 좁혔지 나머지 라우트의
    // 권한을 건드리지 않았다는 것을 확인한다.
    const handler = SessionController.prototype.create;

    expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
  });

  describe('테이블 추가 (tables)', () => {
    const handler = SessionController.prototype.createTable;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });

  describe('테이블 삭제 (tables/:tableId)', () => {
    const handler = SessionController.prototype.deleteTable;

    it('STORE_ADMIN은 통과한다', () => {
      expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(true);
    });

    it('PLATFORM_ADMIN은 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
    });

    it('DEALER는 거부된다', () => {
      expect(guard.canActivate(contextFor(handler, Role.DEALER))).toBe(false);
    });
  });
});
