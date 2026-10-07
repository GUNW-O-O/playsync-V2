import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DEVICE_ROLE, DEVICE_TOKEN_COOKIE, DEVICE_TOKEN_HEADER } from '@playsync/contract';

/**
 * 역할(`DEVICE_ROLE`)은 contract에 있다 — 프론트도 읽는다. `SEAT_ROLE`처럼
 * Prisma `Role` 밖의 값이라 어떤 `@Roles(...)`와도 맞지 않고, `JwtStrategy.validate`가
 * 이 역할을 거절한다. 기기 토큰은 Bearer가 아니라 「이 요청이 등록된 태블릿에서
 * 왔다」는 표지일 뿐이다.
 */
export { DEVICE_ROLE };

/** 매장 비품이라 대회가 아니라 기기에 묶인다. 폐기는 `Store.deviceTokenVersion`이 맡는다. */
const DEVICE_TOKEN_TTL = '365d';

export type DevicePayload = { deviceId: string; storeId: string; ver: number };

/**
 * ponytail: 기기 행을 만들지 않는다. `deviceId`는 서명 안의 난수라 버킷을 가르는
 * 열쇠로만 쓰고, 폐기는 상점 단위(전체 해제)다. 기기별 목록 · 개별 폐기가
 * 필요해지면 `StoreDevice` 행을 두고 `sub`를 그 id로 바꾼다.
 */
export function signDeviceToken(jwt: JwtService, input: { storeId: string; ver: number }): string {
  return jwt.sign(
    { sub: randomUUID(), storeId: input.storeId, ver: input.ver, role: DEVICE_ROLE },
    { expiresIn: DEVICE_TOKEN_TTL },
  );
}

/** 서명이 맞고 모양이 기기 토큰일 때만 돌려준다. 그 외는 전부 null. */
export function verifyDeviceToken(jwt: JwtService, token: string | undefined): DevicePayload | null {
  if (!token) return null;
  let payload: Record<string, unknown>;
  try {
    payload = jwt.verify(token);
  } catch {
    return null;
  }
  const { sub, storeId, ver, role } = payload;
  if (role !== DEVICE_ROLE) return null;
  if (typeof sub !== 'string' || typeof storeId !== 'string' || typeof ver !== 'number') return null;
  return { deviceId: sub, storeId, ver };
}

/**
 * 요청에서 기기 토큰을 꺼낸다.
 *
 * 헤더가 먼저다 — Next 서버 쪽 fetch(서버 액션 · `api/ws-ticket`)가 쿠키를 읽어
 * 싣는다. 헤더가 없으면 `Cookie`를 본다 — Next rewrite(`/api/*`)를 탄 클라이언트
 * fetch는 브라우저 쿠키를 그대로 들고 오므로, 헤더를 안 실어도 버킷이 갈린다.
 */
export function deviceTokenFrom(req: { headers?: Record<string, unknown> }): string | undefined {
  const header = req.headers?.[DEVICE_TOKEN_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;

  const cookie = req.headers?.cookie;
  if (typeof cookie !== 'string') return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === DEVICE_TOKEN_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}
