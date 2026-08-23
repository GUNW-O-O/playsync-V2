import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { MockPaymentController } from './mock-payment.controller';

/**
 * 목업 충전 라우트(T72).
 *
 * **포인트를 늘리는 라우트다.** 그래서 검사가 둘이다 — 누가 부를 수 있는가와,
 * 애초에 존재하는가.
 */
describe('MockPaymentController — 충전 권한', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(handler: Function, role: Role): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => MockPaymentController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as unknown as ExecutionContext;
  }

  const handler = MockPaymentController.prototype.charge;

  it('USER는 통과한다', () => {
    expect(guard.canActivate(contextFor(handler, Role.USER))).toBe(true);
  });

  /**
   * 참가(`PaymentController.joinSession`)와 같은 이유다. 상점 직원이
   * 플레이하고 싶으면 별도 플레이어 계정을 쓴다 — 그 결정이 서 있는데
   * 충전만 열어 두면 STORE_ADMIN이 자기 포인트를 늘릴 수 있다.
   */
  it('STORE_ADMIN은 거부된다', () => {
    expect(guard.canActivate(contextFor(handler, Role.STORE_ADMIN))).toBe(false);
  });

  it('PLATFORM_ADMIN도 거부된다', () => {
    expect(guard.canActivate(contextFor(handler, Role.PLATFORM_ADMIN))).toBe(false);
  });
});

/**
 * 게이팅 — **꺼져 있으면 라우트가 존재하지 않는다.**
 *
 * 요청 시점 가드가 아니라 모듈 등록 시점에 가른다. 가드로 두면 라우트는
 * 살아 있고 판정만 붙는 것이라, 가드 하나가 잘못 걸리는 순간 포인트를
 * 늘리는 경로가 열린다. 등록 자체를 안 하면 **설정이 곧 방어다.**
 *
 * `app.module.ts`의 `LOAD_METRICS`가 이미 같은 모양이다.
 *
 * `jest.isolateModules`로 모듈을 다시 읽는 이유는 조건이 **import 시점에**
 * 평가되기 때문이다. 한 번 읽은 모듈을 재사용하면 환경변수를 바꿔도 배열이
 * 그대로다 — 그러면 이 검사는 아무것도 증명하지 않는다.
 */
describe('PaymentModule — 목업 충전 라우트의 등록', () => {
  const original = process.env.MOCK_PAYMENT;

  afterEach(() => {
    if (original === undefined) delete process.env.MOCK_PAYMENT;
    else process.env.MOCK_PAYMENT = original;
  });

  /**
   * 모듈을 새로 읽어 `@Module`이 실제로 등록한 컨트롤러의 **이름**을 꺼낸다.
   *
   * **이름으로 비교한다.** `isolateModules`는 레지스트리를 새로 만들므로 그
   * 안의 클래스가 위에서 import한 것과 다른 객체다 — 동일성으로 비교하면
   * 음성 검사(`not.toContain`)가 늘 통과해 **아무것도 증명하지 않는다.**
   * 실제로 처음에 그렇게 썼고, 양성 검사가 터져서 드러났다.
   */
  function controllerNamesWith(value: string | undefined): string[] {
    if (value === undefined) delete process.env.MOCK_PAYMENT;
    else process.env.MOCK_PAYMENT = value;

    let names: string[] = [];
    jest.isolateModules(() => {
      const { PaymentModule } = require('./payment.module');
      const controllers: Function[] = Reflect.getMetadata('controllers', PaymentModule) ?? [];
      names = controllers.map((c) => c.name);
    });
    return names;
  }

  it('MOCK_PAYMENT가 없으면 충전 컨트롤러가 등록되지 않는다', () => {
    expect(controllerNamesWith(undefined)).not.toContain('MockPaymentController');
  });

  it("MOCK_PAYMENT=1이면 등록된다", () => {
    expect(controllerNamesWith('1')).toContain('MockPaymentController');
  });

  /**
   * 참 같은 다른 문자열로는 안 켜진다. `MOCK_PAYMENT=false`가 켜지는 것이
   * 배포에서 실제로 겪는 실수고, 그 대가가 포인트를 늘리는 라우트다.
   */
  it("MOCK_PAYMENT=false로는 켜지지 않는다", () => {
    expect(controllerNamesWith('false')).not.toContain('MockPaymentController');
  });

  /** 참가 라우트는 게이팅과 무관하게 늘 있다. 둘을 같이 껐다 켜면 안 된다. */
  it('참가 라우트는 어느 쪽이든 남는다', () => {
    expect(controllerNamesWith(undefined)).toContain('PaymentController');
    expect(controllerNamesWith('1')).toContain('PaymentController');
  });
});
