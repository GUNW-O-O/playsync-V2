import { ArgumentsHost, Catch, HttpException, Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(RedisOutageFilter.name);
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

    // 장애 중이라 503으로 가린 오류다. 응답에는 원본이 안 실리지만(위 문서
    // 주석 — Redis 재시도 실패라고 뭉뚱그려도 되는 것과 달리, Redis와 무관한
    // 진짜 결함이라면 이 로그가 유일한 증거다) 로그에는 남긴다.
    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`장애 중 503으로 가려진 오류: ${err.message}`, err.stack);

    host.switchToHttp().getResponse<Response>().status(SERVER_RECOVERING_STATUS).json({
      statusCode: SERVER_RECOVERING_STATUS,
      message: SERVER_RECOVERING_MESSAGE,
      error: 'Service Unavailable',
    });
  }
}
