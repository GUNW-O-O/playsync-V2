import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * DB 오류를 사람이 읽을 응답으로 바꾼다.
 *
 * 리포에 예외 필터가 하나도 없던 동안 Prisma 오류는 전부 Nest 기본 처리로
 * 500 `Internal server error`가 됐다. 서버 액션들이 본문의 `message`를 꺼내
 * 그대로 보여주므로(`failureMessage`), 사용자에게는 **원인 없는 실패**로
 * 보인다 — 사실은 "이미 있는 값"이거나 "범위를 벗어난 값"이다.
 *
 * **원본 메시지를 그대로 내보내지 않는다.** Prisma 메시지에는 모델·필드·쿼리가
 * 통째로 들어 있고, 참가자 단말은 신뢰 경계 밖이다(`docs/threat-model.md`).
 * 밖으로는 고정 문구만 나가고, 원본은 서버 로그에 남는다.
 *
 * **모르는 코드는 4xx로 내리지 않는다.** 4xx는 "당신이 고칠 수 있다"는 뜻이라,
 * 서버가 원인을 모르는 것을 그렇게 내리면 클라이언트가 고칠 수 없는 것을 두고
 * 재시도하게 된다.
 */
const MAPPED: Record<string, { status: number; message: string }> = {
  // 유니크 위반. 좌석 다툼과 중복 참가가 여기로 온다.
  P2002: { status: HttpStatus.CONFLICT, message: '이미 있는 값입니다.' },
  // 대상 행 없음.
  P2025: { status: HttpStatus.NOT_FOUND, message: '대상을 찾을 수 없습니다.' },
  // 범위 초과. postgres `22003`이 이 코드로 감싸여 올라온다 —
  // `meta.driverAdapterError.cause.originalCode`가 그 값이다(실측).
  P2020: { status: HttpStatus.BAD_REQUEST, message: '값이 허용된 범위를 벗어났습니다.' },
  // 외래키 위반. 없는 대상을 가리킨 요청이다.
  P2003: { status: HttpStatus.BAD_REQUEST, message: '참조하는 대상이 없습니다.' },
};

const FALLBACK = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  message: '요청을 처리하지 못했습니다.',
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const { status, message } = MAPPED[exception.code] ?? FALLBACK;

    // 원본은 여기 남긴다. 밖으로 나가는 것과 안에 남는 것이 다르다는 것이
    // 이 필터의 요점이다.
    this.logger.error(
      `Prisma ${exception.code} → ${status}: ${exception.message}`,
      JSON.stringify(exception.meta ?? {}),
    );

    // 본문 모양은 Nest의 기본 예외 응답과 같다 — 프론트의 `failureMessage`가
    // `{ statusCode, message, error }`를 전제한다.
    host.switchToHttp().getResponse<Response>().status(status).json({
      statusCode: status,
      message,
      error: HttpStatus[status],
    });
  }
}
