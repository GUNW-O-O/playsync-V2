import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DealerController } from 'src/dealer/dealer.controller';
import { DealerService } from 'src/dealer/dealer.service';
import { EntryController } from 'src/entry/entry.controller';
import { EntryService } from 'src/entry/entry.service';
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'gate-secret' })],
      controllers: [EntryController, DealerController],
      providers: [
        { provide: EntryService, useValue: { enterSeat } },
        { provide: DealerService, useValue: { loginDealer } },
        { provide: SessionService, useValue: {} },
        // 대회가 없다 — 토큰이 있어도 통과하지 못하는 상태다.
        { provide: PrismaService, useValue: { tournament: { findUnique: async () => null } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
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
});
