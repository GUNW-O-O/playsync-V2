'use server';

import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ERROR = '요청을 처리하지 못했습니다.';
const NO_TOKEN_ERROR = '로그인이 필요합니다.';

/**
 * 실패 응답에서 안내 문구를 꺼낸다. `table/action.ts`·`dealer/action.ts`와
 * 같은 모양이다 — NestJS 예외 필터의 본문은 `{ statusCode, message, error }`고
 * `message`는 문자열이거나 ValidationPipe가 만든 문자열 배열이다.
 */
function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_ERROR;
}

/**
 * 가드가 있는 상점 콘솔 엔드포인트를 부를 공통 경로.
 *
 * 백엔드는 `ExtractJwt.fromAuthHeaderAsBearerToken()`이라 쿠키를 직접 보지
 * 않는다(`backend/src/auth/strategies/jwt.strategy.ts`). 그래서 쿠키의
 * `accessToken`을 읽어 `Authorization: Bearer`로 실어 보낸다 — 이 태블릿
 * 화면들과 달리 상점 콘솔은 관리자가 로그인한 세션이고, 로그인이 심는
 * 쿠키 이름이 좌석·딜러 토큰과 같은 `accessToken`이다(`session.ts`).
 *
 * 토큰은 이 함수 밖으로 나가지 않는다 — 반환값에도 없다. 다섯 액션이 이
 * 경로 하나로 모이는 이유는, 그래야 "토큰을 반환값에 담지 않는다"는 규칙을
 * 한 곳에서만 지키면 되기 때문이다.
 */
async function callConsoleApi(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; body: unknown } | { error: string }> {
  const token = (await cookies()).get('accessToken')?.value;
  if (!token) return { error: NO_TOKEN_ERROR };

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: failureMessage(body) };
  return { ok: true, body };
}

type ActionResult = { ok: true } | { error: string };

/** `PATCH /store/sessions/:id/start`. */
export async function startTournament(tournamentId: string): Promise<ActionResult> {
  const result = await callConsoleApi(`/store/sessions/${tournamentId}/start`, { method: 'PATCH' });
  return 'error' in result ? result : { ok: true };
}

/** `POST /store/sessions/:id/tables`. 본문이 없다. */
export async function openTable(tournamentId: string): Promise<ActionResult> {
  const result = await callConsoleApi(`/store/sessions/${tournamentId}/tables`, { method: 'POST' });
  return 'error' in result ? result : { ok: true };
}

/** `DELETE /store/sessions/:id/tables/:tableId`. 앉은 사람이 있으면 409다. */
export async function closeTable(tournamentId: string, tableId: string): Promise<ActionResult> {
  const result = await callConsoleApi(
    `/store/sessions/${tournamentId}/tables/${tableId}`,
    { method: 'DELETE' },
  );
  return 'error' in result ? result : { ok: true };
}

/**
 * `POST /store/sessions/:id/tables/:tableId/seats/release`.
 *
 * `userId`를 함께 보내는 이유는 `backend/shared/dto/seat-release.dto.ts`의
 * `ReleaseSeatItem` 주석에 있다 — 상점 콘솔이 조금 전에 그린 판을 보고
 * 체크하는 사이 그 자리 사람이 바뀔 수 있다.
 */
export async function releaseSeats(
  tournamentId: string,
  tableId: string,
  seats: { seatIndex: number; userId: string }[],
): Promise<ActionResult> {
  const result = await callConsoleApi(
    `/store/sessions/${tournamentId}/tables/${tableId}/seats/release`,
    { method: 'POST', body: JSON.stringify({ seats }) },
  );
  return 'error' in result ? result : { ok: true };
}

/**
 * `POST /store/sessions/:id/dealer-otp/reissue`.
 *
 * 응답에 실려 오는 평문 딜러 OTP는 **화면으로 가는 것이 이 호출의 목적**이라
 * 반환값에 그대로 둔다(`session.service.ts`의 `reissueDealerOtp` 주석 —
 * "상점 콘솔이 이 응답을 보여주는 것이 유일한 열람 경로다"). 반환값에 없는
 * 것은 이 호출을 인증하는 데 쓴 관리자의 accessToken 쪽이다 — 그건 화면이
 * 볼 이유가 없는 다른 토큰이다.
 */
export async function reissueDealerOtp(
  tournamentId: string,
): Promise<{ ok: true; dealerOtp: string } | { error: string }> {
  const result = await callConsoleApi(
    `/store/sessions/${tournamentId}/dealer-otp/reissue`,
    { method: 'POST' },
  );
  if ('error' in result) return result;
  return { ok: true, dealerOtp: (result.body as { dealerOtp: string }).dealerOtp };
}
