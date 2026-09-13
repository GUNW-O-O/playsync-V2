import { ArgumentsHost, Catch, HttpException, Injectable } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { SERVER_RECOVERING_MESSAGE, SERVER_RECOVERING_STATUS } from '@playsync/contract';
import type { Response } from 'express';
import { RedisService } from 'src/redis/redis.service';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * Redis 장애 중에 난 오류를 503으로 내린다(T97).
 *
 * 장애 중 REST는 ioredis가 재시도를 다 쓴 뒤 500 `Internal server error`를
 * 냈다(실측 약 5초). 화면은 그것을 원인 없는 실패로 그리거나, 대회 상세처럼
 * 「대회를 찾을 수 없습니다」라는 **틀린 말**을 했다.
 *
 * **장애 중일 때만 바꾼다.** Redis가 멀쩡할 때의 오류를 503으로 내리면 진짜
 * 결함이 「복구 중」으로 가려진다. HTTP 예외와 Prisma 오류도 장애가 아니므로
 * 원래 처리로 넘긴다.
 */
@Catch()
@Injectable()
export class RedisOutageFilter extends BaseExceptionFilter {
  private readonly prismaFilter = new PrismaExceptionFilter();

  constructor(private readonly redis: RedisService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.prismaFilter.catch(exception, host);
    }
    if (this.redis.outage.isUp() || exception instanceof HttpException) {
      return super.catch(exception, host);
    }
    host.switchToHttp().getResponse<Response>().status(SERVER_RECOVERING_STATUS).json({
      statusCode: SERVER_RECOVERING_STATUS,
      message: SERVER_RECOVERING_MESSAGE,
      error: 'Service Unavailable',
    });
  }
}
