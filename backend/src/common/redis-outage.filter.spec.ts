import { Controller, Get, INestApplication, NotFoundException } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { SERVER_RECOVERING_MESSAGE, SERVER_RECOVERING_STATUS } from '@playsync/contract';
import { RedisService } from 'src/redis/redis.service';
import { PrismaExceptionFilter } from './prisma-exception.filter';
import { RedisOutageFilter } from './redis-outage.filter';

/**
 * **장애 중 REST가 무엇을 내는가**를 고정한다.
 *
 * 장애 중 REST는 ioredis가 재시도를 다 쓴 뒤 500 `Internal server error`를
 * 냈다(실측 약 5초). `PrismaExceptionFilter`의 스펙과 같은 방식으로 진짜
 * 컨트롤러를 띄우고 `APP_FILTER`로 건다 — 등록까지 검증한다.
 */
function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('원본 메시지', { code, clientVersion: 'test' });
}

@Controller('boom')
class BoomController {
  @Get('generic')
  generic(): never {
    throw new Error('Connection is closed.');
  }

  @Get('http')
  http(): never {
    throw new NotFoundException('없는 대회입니다.');
  }

  @Get('prisma')
  prisma(): never {
    throw prismaError('P2002');
  }
}

/** `up`을 밖에서 뒤집을 수 있는 `RedisService` 대역. */
function makeApp(up: boolean) {
  return Test.createTestingModule({
    controllers: [BoomController],
    providers: [
      { provide: RedisService, useValue: { outage: { isUp: () => up } } },
      // app.module.ts와 같은 순서 — PrismaExceptionFilter가 먼저다. Nest의
      // 전역 필터 선택 순서를 추측하지 않고 이 스펙으로 확인한다.
      { provide: APP_FILTER, useClass: PrismaExceptionFilter },
      { provide: APP_FILTER, useClass: RedisOutageFilter },
    ],
  }).compile();
}

describe('RedisOutageFilter', () => {
  let downApp: INestApplication;
  let upApp: INestApplication;

  beforeAll(async () => {
    const downModule = await makeApp(false);
    downApp = downModule.createNestApplication();
    downApp.useLogger(false);
    await downApp.init();

    const upModule = await makeApp(true);
    upApp = upModule.createNestApplication();
    upApp.useLogger(false);
    await upApp.init();
  });

  afterAll(async () => {
    await downApp.close();
    await upApp.close();
  });

  it('down 중 모르는 오류는 503 「복구 중」으로 나간다', async () => {
    const res = await request(downApp.getHttpServer()).get('/boom/generic');

    expect(res.status).toBe(SERVER_RECOVERING_STATUS);
    expect(res.body).toEqual({
      statusCode: SERVER_RECOVERING_STATUS,
      message: SERVER_RECOVERING_MESSAGE,
      error: 'Service Unavailable',
    });
  });

  it('up일 때 같은 오류는 500 그대로다 (반대 입력 — 진짜 결함을 장애로 가리지 않는다)', async () => {
    const res = await request(upApp.getHttpServer()).get('/boom/generic');

    expect(res.status).toBe(500);
    expect(res.body.message).not.toBe(SERVER_RECOVERING_MESSAGE);
  });

  it('down 중에도 HTTP 예외는 그대로 통과한다 (HTTP 예외는 장애가 아니다)', async () => {
    const res = await request(downApp.getHttpServer()).get('/boom/http');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('없는 대회입니다.');
  });

  it('down 중에도 Prisma 오류는 PrismaExceptionFilter가 그대로 낸다', async () => {
    const res = await request(downApp.getHttpServer()).get('/boom/prisma');

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('이미 있는 값입니다.');
  });
});
