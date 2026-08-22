import { Controller, Get, HttpException, INestApplication, NotFoundException } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * **DB 오류가 화면에 무엇으로 보이는가**를 고정한다.
 *
 * 리포에 예외 필터가 하나도 없던 동안, Prisma 오류는 전부 Nest 기본 처리로
 * 500 `Internal server error`가 됐다. 서버 액션들은 본문의 `message`를 꺼내
 * 사용자에게 보여주므로(`failureMessage`), 사용자에게는 **원인 없는 실패**로
 * 보인다 — 사실은 "이미 있는 값"이거나 "범위를 벗어난 값"이다.
 *
 * 진짜 컨트롤러를 띄우고 실제 Prisma 오류 객체를 던진다. 필터를 `APP_FILTER`로
 * 걸므로 이 스펙은 **등록까지** 검증한다 — `main.ts`에 손으로 걸면 그 줄을
 * 지워도 아무 테스트도 울지 않는다.
 */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('원본 메시지 — 밖으로 나가면 안 된다', {
    code,
    clientVersion: 'test',
    meta,
  });
}

@Controller('boom')
class BoomController {
  @Get('unique')
  unique() {
    throw prismaError('P2002', { target: ['playerOtp'] });
  }

  @Get('missing')
  missing() {
    throw prismaError('P2025');
  }

  @Get('range')
  range() {
    // postgres 22003은 이 모양으로 올라온다(실측).
    throw prismaError('P2020', {
      driverAdapterError: { cause: { originalCode: '22003', originalMessage: 'integer out of range' } },
    });
  }

  @Get('foreign')
  foreign() {
    throw prismaError('P2003');
  }

  @Get('unknown')
  unknown() {
    throw prismaError('P2010');
  }

  @Get('http')
  http(): never {
    throw new NotFoundException('없는 대회입니다.');
  }
}

describe('PrismaExceptionFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
      providers: [{ provide: APP_FILTER, useClass: PrismaExceptionFilter }],
    }).compile();

    app = moduleRef.createNestApplication();
    // 필터가 로그를 찍는 경로가 있어 콘솔을 막는다. 검증 대상은 응답이다.
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('유니크 위반은 409로 나간다', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unique');

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('이미 있는 값입니다.');
  });

  it('없는 대상은 404로 나간다', async () => {
    const res = await request(app.getHttpServer()).get('/boom/missing');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('대상을 찾을 수 없습니다.');
  });

  it('범위를 벗어난 값은 400으로 나간다', async () => {
    // 지금까지 500이던 자리다. 사람이 고칠 수 있는 입력 오류라 4xx여야 한다.
    const res = await request(app.getHttpServer()).get('/boom/range');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('값이 허용된 범위를 벗어났습니다.');
  });

  it('참조가 없는 값은 400으로 나간다', async () => {
    const res = await request(app.getHttpServer()).get('/boom/foreign');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('참조하는 대상이 없습니다.');
  });

  it('모르는 Prisma 오류는 500 일반 문구로 덮는다', async () => {
    // 모르는 것을 4xx로 내리면 클라이언트가 고칠 수 있는 것처럼 보인다.
    const res = await request(app.getHttpServer()).get('/boom/unknown');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('요청을 처리하지 못했습니다.');
  });

  it('원본 메시지와 제약 이름을 밖으로 내보내지 않는다', async () => {
    // Prisma 메시지에는 모델·필드·쿼리가 통째로 들어 있다. 참가자 단말은
    // 신뢰 경계 밖이다(`docs/threat-model.md`).
    const res = await request(app.getHttpServer()).get('/boom/unique');

    expect(JSON.stringify(res.body)).not.toContain('원본 메시지');
    expect(JSON.stringify(res.body)).not.toContain('playerOtp');
  });

  it('도메인 예외는 그대로 통과시킨다', async () => {
    // 이 단언이 없으면 "전부 500으로 덮는" 필터도 위를 통과한다.
    const res = await request(app.getHttpServer()).get('/boom/http');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('없는 대회입니다.');
  });
});
