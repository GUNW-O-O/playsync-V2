import { APP_FILTER } from '@nestjs/core';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';

/**
 * **필터가 실제로 앱에 걸려 있는가.**
 *
 * `PrismaExceptionFilter`의 스펙은 필터가 걸린 앱에서 무엇이 나가는지를 보지만,
 * 그 앱은 스펙이 직접 세운 것이다. 등록을 지워도 그쪽은 초록으로 남는다.
 *
 * `main.ts`가 아니라 `AppModule`에 거는 이유가 이것이다 — `main.ts`는 어떤
 * 테스트도 부팅하지 않아, 거기 건 줄은 지워져도 아무도 울지 않는다.
 */
describe('AppModule의 전역 예외 필터', () => {
  it('Prisma 예외 필터를 APP_FILTER로 건다', () => {
    // `AppModule`은 import 시점에 JWT_SECRET을 요구한다(`auth.module`).
    // 검증 대상은 인증이 아니라 등록이라 값만 세워 두고 들인다.
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-only-not-a-real-secret';
    const { AppModule } = require('./app.module') as typeof import('./app.module');

    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];

    const registered = providers.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === APP_FILTER &&
        (p as { useClass?: unknown }).useClass === PrismaExceptionFilter,
    );

    expect(registered).toBe(true);
  });
});
