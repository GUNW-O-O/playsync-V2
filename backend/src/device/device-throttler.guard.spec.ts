import { Controller, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { signDeviceToken } from './device-token';
import { DeviceThrottlerGuard } from './device-throttler.guard';

@Controller('probe')
class ProbeController {
  @Post()
  hit() {
    return { ok: true };
  }
}

/**
 * 태블릿이 Next 주소 버킷에서 빠지는가.
 *
 * supertest는 전부 같은 주소(루프백)에서 온다 — 이 리포의 실제 토폴로지(모든
 * 브라우저 요청이 Next 프로세스 하나의 주소)와 같은 모양이다.
 */
describe('DeviceThrottlerGuard', () => {
  let app: INestApplication;
  let deviceToken: string;
  const LIMIT = 3;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: 'throttle-secret' }),
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: LIMIT }] }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: DeviceThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    deviceToken = signDeviceToken(moduleRef.get(JwtService), { storeId: 's', ver: 0 });

    // 토큰 없는 쪽(= Next 주소)이 버킷을 채운다.
    for (let i = 0; i < LIMIT; i++) {
      await request(app.getHttpServer()).post('/probe').expect(201);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('토큰 없는 쪽은 상한에 걸린다', async () => {
    await request(app.getHttpServer()).post('/probe').expect(429);
  });

  it('등록된 기기는 같은 주소여도 통과한다 — 헤더', async () => {
    await request(app.getHttpServer()).post('/probe').set('x-device-token', deviceToken).expect(201);
  });

  it('등록된 기기는 같은 주소여도 통과한다 — 쿠키(rewrite 경로)', async () => {
    await request(app.getHttpServer()).post('/probe').set('Cookie', `deviceToken=${deviceToken}`).expect(201);
  });

  it('위조 토큰은 새 버킷을 못 얻는다', async () => {
    await request(app.getHttpServer()).post('/probe').set('x-device-token', 'forged-1').expect(429);
    await request(app.getHttpServer()).post('/probe').set('x-device-token', 'forged-2').expect(429);
  });

  it('다른 키로 서명한 토큰도 새 버킷을 못 얻는다', async () => {
    const foreign = signDeviceToken(new JwtService({ secret: 'other' }), { storeId: 's', ver: 0 });
    await request(app.getHttpServer()).post('/probe').set('x-device-token', foreign).expect(429);
  });
});
