'use server';

import { cookies } from 'next/headers';
import { DEVICE_TOKEN_COOKIE } from '@playsync/contract';
import { cookieMaxAgeFromToken } from '@/lib/token-cookie';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const DEFAULT_ERROR = '태블릿을 등록하지 못했습니다.';

function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_ERROR;
}

/**
 * 이 태블릿을 매장 태블릿으로 등록한다(T112).
 *
 * 점주가 태블릿 대기 화면에서 자기 계정을 넣는다. 로그인으로 받은 점주 토큰은
 * **등록 요청 하나에만 쓰고 버린다** — 쿠키에 남기면 손님 앞 태블릿이 점주로
 * 로그인된 채 놓인다. 심는 것은 기기 토큰 하나다.
 */
export async function registerDevice(input: {
  storeId: string;
  nickname: string;
  password: string;
}): Promise<{ ok: true } | { error: string }> {
  const login = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: input.nickname, password: input.password }),
    cache: 'no-store',
  });
  const loginBody = await login.json().catch(() => null);
  if (!login.ok) return { error: failureMessage(loginBody) };
  const ownerToken = (loginBody as { accessToken: string }).accessToken;

  const res = await fetch(`${BACKEND_URL}/store/${input.storeId}/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: failureMessage(body) };

  const deviceToken = (body as { deviceToken: string }).deviceToken;
  (await cookies()).set(DEVICE_TOKEN_COOKIE, deviceToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: cookieMaxAgeFromToken(deviceToken),
  });
  return { ok: true };
}
