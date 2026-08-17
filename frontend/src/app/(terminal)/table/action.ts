'use server';

import { cookies } from 'next/headers';
import { cookieMaxAgeFromToken } from '@/lib/token-cookie';

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

  const token = (body as { accessToken: string }).accessToken;
  const cookieStore = await cookies();

  cookieStore.set('accessToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // 수명은 토큰이 정한다(`lib/token-cookie.ts`). 좌석 토큰은 12시간인데
    // 여기 1시간이 박혀 있어서, 좌석마다 한 시간에 한 번 OTP를 다시 넣어야
    // 했다 — T43이 없앤 증상이 프론트에 남아 있었다.
    maxAge: cookieMaxAgeFromToken(token),
  });

  // **이 태블릿이 아까 딜러였을 수 있다.** `api/ws-ticket/route.ts`가
  // `dealerToken`을 먼저 보므로, 지우지 않으면 손님의 좌석 토큰 대신 옛 딜러
  // 토큰으로 티켓이 나가고 게이트웨이가 1008로 끊는다. 그 자리는 쿠키가
  // 만료될 때까지 못 붙는다.
  cookieStore.delete('dealerToken');

  return { ok: true, tableId: input.tableId };
}
