import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DealerController } from 'src/dealer/dealer.controller';
import { DealerService } from 'src/dealer/dealer.service';
import { EntryController } from 'src/entry/entry.controller';
import { EntryService } from 'src/entry/entry.service';
import { DEVICE_TOKEN_HEADER } from '@playsync/contract';
import { signDeviceToken } from 'src/device/device-token';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionService } from 'src/store/session/session.service';

/**
 * 문이 **배선**돼 있는가를 본다. 판정 자체는 `device.guard.int-spec.ts`가 본다.
 *
 * 「서비스가 한 번도 불리지 않는다」가 이 스펙의 값이다 — 딜러 인증에서
 * 서비스가 불리면 그 첫 줄(`reserveAttempt`)이 잠금 슬롯을 쓴다.
 */
describe('기기 문의 배선', () => {
  let app: INestApplication;
  const enterSeat = jest.fn(async () => ({ accessToken: 'seat' }));
  const loginDealer = jest.fn(async () => ({ accessToken: 'dealer' }));
  // 대회는 store-a 소속이고 그 상점의 기기 버전은 0이다.
  const findUnique = jest.fn(async () => ({ storeId: 'store-a', store: { deviceTokenVersion: 0 } }));
  let jwt: JwtService;
  const tokenOf = (storeId: string) => signDeviceToken(jwt, { storeId, ver: 0 });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'gate-secret' })],
      controllers: [EntryController, DealerController],
      providers: [
        { provide: EntryService, useValue: { enterSeat } },
        { provide: DealerService, useValue: { loginDealer } },
        { provide: SessionService, useValue: {} },
        { provide: PrismaService, useValue: { tournament: { findUnique } } },
      ],
    }).compile();
    jwt = moduleRef.get(JwtService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    enterSeat.mockClear();
    loginDealer.mockClear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('토큰 없는 입장은 401이고 EntryService가 불리지 않는다', async () => {
    const res = await request(app.getHttpServer())
      .post('/tournaments/trn-1/enter')
      .send({ otp: '00000000', tableId: 't', seatIndex: 0 });
    expect(res.status).toBe(401);
    expect(enterSeat).not.toHaveBeenCalled();
  });

  it('토큰 없는 딜러 인증은 401이고 DealerService가 불리지 않는다', async () => {
    const res = await request(app.getHttpServer())
      .post('/dealer/auth')
      .send({ tournamentId: 'trn-1', tableId: 't', otp: '000000' });
    expect(res.status).toBe(401);
    expect(loginDealer).not.toHaveBeenCalled();
  });

  const enter = (token: string) =>
    request(app.getHttpServer())
      .post('/tournaments/trn-1/enter')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ otp: '00000000', tableId: 't', seatIndex: 0 });

  it('맞는 상점의 토큰이면 입장이 통과해 EntryService가 한 번 불린다', async () => {
    const res = await enter(tokenOf('store-a'));
    expect(res.status).toBe(201);
    expect(enterSeat).toHaveBeenCalledTimes(1);
  });

  it('맞는 상점의 토큰이면 딜러 인증이 통과해 loginDealer가 한 번 불린다', async () => {
    const res = await request(app.getHttpServer())
      .post('/dealer/auth')
      .set(DEVICE_TOKEN_HEADER, tokenOf('store-a'))
      .send({ tournamentId: 'trn-1', tableId: 't', otp: '000000' });
    expect(res.status).toBe(201);
    expect(loginDealer).toHaveBeenCalledTimes(1);
  });

  it('다른 상점의 토큰은 401이고 서비스가 불리지 않는다', async () => {
    const res = await enter(tokenOf('store-b'));
    expect(res.status).toBe(401);
    expect(enterSeat).not.toHaveBeenCalled();
  });
});
