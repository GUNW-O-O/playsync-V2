'use server';

import { cookies } from 'next/headers';
import { cookieMaxAgeFromToken } from '@/lib/token-cookie';

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

  const token = (body as { accessToken: string }).accessToken;
  const cookieStore = await cookies();

  cookieStore.set('dealerToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // 수명은 토큰이 정한다. 숫자를 여기 적으면 백엔드가 바꿀 때 조용히
    // 어긋난다 — T43에서 실제로 그랬다(`lib/token-cookie.ts`).
    maxAge: cookieMaxAgeFromToken(token),
  });

  // **태블릿 하나는 한 번에 한 자리다.** 딜러 태블릿이 고장 나면 좌석
  // 태블릿을 딜러용으로 돌려 쓰는 일이 실제로 있고, 그때 옛 좌석 토큰이
  // 남아 있으면 이 기기의 역할이 둘이 된다. 마지막에 인증한 역할만 남긴다.
  cookieStore.delete('accessToken');

  return { ok: true };
}
