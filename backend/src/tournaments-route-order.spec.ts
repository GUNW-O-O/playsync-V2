import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EntryController } from './entry/entry.controller';
import { EntryService } from './entry/entry.service';
import { PaymentController } from './payment/payment.controller';
import { PaymentService } from './payment/payment.service';

/**
 * `PaymentController`·`EntryController`가 둘 다 `@Controller('tournaments')`를
 * 쓴다(T66, 잔여 목록). 겹치는 패턴이 있다 —
 * `GET /tournaments/stores/:storeId`(Payment)와 `GET /tournaments/:id/seats`
 * (Entry)는 세그먼트 수가 같아서, `GET /tournaments/stores/seats`라는 경로
 * **하나**가 둘 다에 매치된다(Payment는 `storeId='seats'`로, Entry는
 * `tournamentId='stores'`로 읽는다). 어느 쪽이 응답하는지는 어느 컨트롤러가
 * 먼저 등록됐는지 — 즉 `app.module.ts`의 `imports` 순서 — 로 정해진다.
 * 지금은 `PaymentModule`이 `EntryModule`보다 앞이라 Payment가 이긴다.
 *
 * 아무 테스트도 이 순서를 요구하지 않았다. 순서가 바뀌면 여기가 먼저
 * 빨개지도록 둘을 함께 본다 — (1) `AppModule` 메타데이터의 실제 순서,
 * (2) 그 순서에서 실제로 어느 컨트롤러가 응답하는지(진짜 HTTP 요청으로).
 */
describe('PaymentController·EntryController — tournaments 라우트 순서', () => {
  /**
   * `AppModule`은 로드 시점에 `AuthModule`을 거쳐 `JWT_SECRET`을 요구한다
   * (`jwt.strategy.ts`의 `requireJwtSecret`). `auth.throttle.spec.ts`의
   * "AppModule 배선" 검사와 같은 이유로 동적 `require`를 쓴다 — 정적
   * import는 이 파일이 로드되는 즉시(테스트 실행 전에) 평가돼 값을 세울
   * 틈이 없다.
   */
  it('AppModule은 PaymentModule을 EntryModule보다 먼저 import한다', () => {
    const secret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'route-order-spec-secret';

    jest.resetModules();
    const { AppModule } = require('./app.module') as typeof import('./app.module');
    const { PaymentModule } = require('./payment/payment.module') as typeof import('./payment/payment.module');
    const { EntryModule } = require('./entry/entry.module') as typeof import('./entry/entry.module');

    if (secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secret;

    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const paymentIndex = imports.indexOf(PaymentModule);
    const entryIndex = imports.indexOf(EntryModule);

    expect(paymentIndex).toBeGreaterThanOrEqual(0);
    expect(entryIndex).toBeGreaterThanOrEqual(0);
    expect(paymentIndex).toBeLessThan(entryIndex);
  });

  it('그 순서에서 GET /tournaments/stores/seats는 PaymentController가 받는다', async () => {
    const findAvailableSessions = jest.fn().mockResolvedValue([]);
    const getSeatMap = jest.fn().mockResolvedValue([]);

    // 컨트롤러 배열 순서가 곧 라우트 등록 순서다. AppModule의 실제 순서
    // (PaymentModule 먼저)를 그대로 옮긴다 — 여기서 순서를 뒤집으면 이
    // 스펙 자체가 무엇을 보장하는지 증명하지 못한다(둘 다 통과해 버린다).
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentController, EntryController],
      providers: [
        {
          provide: PaymentService,
          useValue: {
            searchStore: jest.fn(),
            getStoreAvailableSessions: findAvailableSessions,
            getTournamentInfo: jest.fn(),
            joinSession: jest.fn(),
          },
        },
        { provide: EntryService, useValue: { getSeatMap, enterSeat: jest.fn() } },
      ],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/tournaments/stores/seats');

    // Payment 쪽 핸들러(`findAvailableSessions` → `getStoreAvailableSessions`)가
    // storeId='seats'로 불린다. Entry 쪽(`getSeatMap`)은 아예 호출되지
    // 않는다 — 순서가 바뀌면 이 기대가 뒤집힌다.
    expect(findAvailableSessions).toHaveBeenCalledWith('seats');
    expect(getSeatMap).not.toHaveBeenCalled();

    await app.close();
  });

  /**
   * 반대 순서를 직접 보여준다. 위 스펙이 "지금 순서에서 Payment가 이긴다"만
   * 증명하면 "순서가 그 결과를 만든다"는 별개 주장이라 증명되지 않는다 —
   * 순서와 무관하게 Payment가 항상 이기는 다른 이유(라우트 특정성 등)가
   * 있을 수도 있기 때문이다. 등록 순서를 뒤집으면 실제로 승자가 바뀐다는
   * 것까지 봐야 "그 순서가 원인"이라는 주장이 선다.
   */
  it('컨트롤러 등록 순서를 뒤집으면 승자도 뒤집힌다 — 순서가 원인임을 보인다', async () => {
    const findAvailableSessions = jest.fn().mockResolvedValue([]);
    const getSeatMap = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      controllers: [EntryController, PaymentController],
      providers: [
        {
          provide: PaymentService,
          useValue: {
            searchStore: jest.fn(),
            getStoreAvailableSessions: findAvailableSessions,
            getTournamentInfo: jest.fn(),
            joinSession: jest.fn(),
          },
        },
        { provide: EntryService, useValue: { getSeatMap, enterSeat: jest.fn() } },
      ],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/tournaments/stores/seats');

    expect(getSeatMap).toHaveBeenCalledWith('stores');
    expect(findAvailableSessions).not.toHaveBeenCalled();

    await app.close();
  });
});
