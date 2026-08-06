'use server';

import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ENTER_ERROR = 'OTP를 확인하세요.';

/**
 * 실패 응답에서 안내 문구를 꺼낸다. `dealer/action.ts`의 `failureMessage`와
 * 같은 모양이다 — NestJS 예외 필터의 본문은 `{ statusCode, message, error }`이고
 * `message`는 예외에서 온 문자열이거나 ValidationPipe에서 온 문자열 배열이다.
 */
function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_ENTER_ERROR;
}

/**
 * 참가 OTP로 좌석을 확정하고 좌석 토큰을 httpOnly 쿠키로 심는다.
 *
 * 응답 키가 `accessToken`이고 안에 든 것은 `role: SEAT_ROLE`인 **좌석 토큰**이다
 * (`entry.service.ts`). 쿠키 이름을 그대로 재사용한다 — 태블릿은 사용자
 * 로그인을 하지 않으므로 실제 기기에서 두 값이 한 브라우저에 같이 있을 일이 없다.
 *
 * 토큰은 이 함수 밖으로 나가지 않는다. 반환값에도 없다.
 */
export async function enterSeat(input: {
  tournamentId: string;
  tableId: string;
  seatIndex: number;
  otp: string;
}): Promise<{ ok: true; tableId: string } | { error: string }> {
  const res = await fetch(`${BACKEND_URL}/tournaments/${input.tournamentId}/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp: input.otp, tableId: input.tableId, seatIndex: input.seatIndex }),
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: failureMessage(body) };

  const cookieStore = await cookies();
  cookieStore.set('accessToken', (body as { accessToken: string }).accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // 백엔드 JWT 만료가 1시간이다. 더 길게 잡으면 죽은 토큰으로 붙으려다
    // 티켓 발급에서 401을 받는다(`dealer/action.ts`와 같은 근거).
    maxAge: 60 * 60,
  });

  return { ok: true, tableId: input.tableId };
}
