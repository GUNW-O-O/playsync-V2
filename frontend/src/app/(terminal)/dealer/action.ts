'use server';

import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_AUTH_ERROR = 'OTP를 확인하세요.';

/**
 * 실패 응답에서 안내 문구를 꺼낸다.
 *
 * NestJS 예외 필터의 본문은 `{ statusCode, message, error }`이고, `message`는
 * 예외에서 온 문자열이거나 ValidationPipe에서 온 문자열 배열이다. 본문이 비어
 * 있거나 JSON이 아닌 경우(프록시가 끊은 502 등)도 있으므로 기본 문구로 떨어진다.
 */
function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;

  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_AUTH_ERROR;
}

/**
 * 딜러를 인증하고 토큰을 httpOnly 쿠키로 심는다.
 *
 * 클라이언트에서 `js-cookie`로 심던 것을 서버로 옮겼다. `js-cookie`는 httpOnly를
 * 설정할 수 없어 이 토큰이 `document.cookie`로 읽혔고, 이 토큰이 곧 승자 지정
 * 권한이다 — 승자는 계산되는 값이 아니라 딜러가 입력하는 값이라 사후에 검증할
 * 정답이 없다.
 *
 * 토큰은 이 함수 밖으로 나가지 않는다. 반환값에도 없다.
 */
export async function authenticateDealer(input: {
  tournamentId: string;
  tableId: string;
  otp: string;
}): Promise<{ ok: true } | { error: string }> {
  const res = await fetch(`${BACKEND_URL}/dealer/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return { error: failureMessage(body) };
  }

  const cookieStore = await cookies();
  cookieStore.set('dealerToken', (body as { accessToken: string }).accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // 백엔드 JWT 만료가 1시간이다. 쿠키를 더 길게 잡으면 이미 죽은 토큰으로
    // 붙으려다 티켓 발급에서 401을 받는다.
    maxAge: 60 * 60,
  });

  return { ok: true };
}
