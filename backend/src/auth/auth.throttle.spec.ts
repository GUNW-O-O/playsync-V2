import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * 상한이 **실제로 라우트 앞에 서는가**를 본다.
 *
 * 설정값 스펙(`throttle.spec.ts`)은 숫자가 맞는지만 본다. 숫자가 맞아도
 * 가드를 안 걸면 아무 일도 일어나지 않으므로, 여기서는 진짜 컨트롤러를 띄우고
 * 한도를 넘겨 429가 나오는지 확인한다. `AuthService`만 목으로 바꾼다 —
 * 검증 대상이 로그인 로직이 아니라 그 앞의 문이다.
 *
 * 한도는 환경변수로 3까지 낮춰서 잰다. 기본값(120)으로 재면 스펙이 느려지기도
 * 하지만, 그보다 **env 경로 자체가 검증 대상**이다 — 부하 프로파일이 쓰는
 * 길이 이것이라 여기서 한 번 밟아 둔다.
 */
describe('인증 라우트 요청율 상한', () => {
  let app: INestApplication;

  const before = {
    auth: process.env.THROTTLE_AUTH_LIMIT,
    global: process.env.THROTTLE_LIMIT,
  };

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = '3';
    process.env.THROTTLE_LIMIT = '1000';

    // 데코레이터가 import 시점에 env를 읽으므로, 값을 세운 뒤에 들여야 한다.
    // 동적 `import()`가 아니라 `require`인 이유는 ts-jest가 CJS로 돌기 때문이다
    // (동적 import는 `--experimental-vm-modules` 없이는 던진다).
    jest.resetModules();
    const { AuthController } = require('./auth.controller') as typeof import('./auth.controller');
    const { AuthService } = require('./auth.service') as typeof import('./auth.service');
    const { throttlerOptions } = require('./throttle') as typeof import('./throttle');

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerOptions())],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: { login: async () => ({ accessToken: 'x' }) } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env.THROTTLE_AUTH_LIMIT = before.auth;
    process.env.THROTTLE_LIMIT = before.global;
    if (before.auth === undefined) delete process.env.THROTTLE_AUTH_LIMIT;
    if (before.global === undefined) delete process.env.THROTTLE_LIMIT;
  });

  it('한도를 넘긴 요청은 429로 끊긴다', async () => {
    const body = { nickname: 'someone', password: 'wrong-but-irrelevant' };

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app.getHttpServer()).post('/auth/login').send(body);
      codes.push(res.status);
    }

    // 앞의 셋은 통과하고 넷째만 막힌다. "전부 막힘"도 "전부 통과"도 아니라는
    // 것을 함께 못 박는다 — 둘 다 설정 실수의 흔한 모양이다.
    expect(`${codes.slice(0, 3).join(',')} 그다음 ${codes[3]}`).toBe('201,201,201 그다음 429');
  });
});

/**
 * 가드가 **전역**으로 걸려 있는가.
 *
 * 위 스펙은 테스트 모듈이 직접 `APP_GUARD`를 등록한다 — 그래서 제품이 그것을
 * 등록했는지는 증명하지 못한다. 빠뜨리면 데코레이터만 남고 아무도 세지 않는데,
 * 그 상태가 조용하다(요청은 다 통과한다). 그래서 모듈 메타데이터를 직접 본다.
 */
describe('AppModule 배선', () => {
  it('ThrottlerGuard가 APP_GUARD로 등록돼 있다', () => {
    // `AuthModule`이 import 시점에 시크릿을 요구한다(`jwt-secret.ts`) —
    // 없으면 던지도록 만든 것이 그쪽 설계다. 값의 내용은 여기서 무관하다.
    const secret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'throttle-spec-secret';

    // 같은 모듈 레지스트리에서 꺼내야 한다. `resetModules` 뒤의 `app.module`은
    // 새로 로드된 `@nestjs/throttler`를 쓰므로, 파일 맨 위에서 import한
    // `ThrottlerGuard`와는 **다른 클래스 객체**다 — 그대로 비교하면 배선이
    // 맞아도 실패한다.
    jest.resetModules();
    const { AppModule } = require('../app.module') as typeof import('../app.module');
    const throttler = require('@nestjs/throttler') as typeof import('@nestjs/throttler');
    const core = require('@nestjs/core') as typeof import('@nestjs/core');

    if (secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secret;

    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as {
      provide?: unknown;
      useClass?: unknown;
    }[];

    const registered = providers.some(
      (p) => p?.provide === core.APP_GUARD && p?.useClass === throttler.ThrottlerGuard,
    );

    expect(`전역 가드 ${registered ? '있음' : '없음'}`).toBe('전역 가드 있음');
  });
});
