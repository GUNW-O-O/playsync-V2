import { DEVICE_ROLE, DEVICE_TOKEN_HEADER } from '@playsync/contract';

/**
 * 매장 태블릿 기기 토큰(T112)의 프론트 쪽 해석.
 *
 * **서명을 검증하지 않는다.** 여기서 정하는 것은 「등록 폼을 그릴까」뿐이고,
 * 권한은 백엔드의 `DeviceGuard`가 매 요청 판정한다(`token-cookie.ts`와 같은 이유).
 */
export function deviceStoreId(token: string | undefined): string | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return payload?.role === DEVICE_ROLE && typeof payload.storeId === 'string' ? payload.storeId : null;
  } catch {
    return null;
  }
}

/** Next 서버 쪽 fetch가 기기 토큰을 백엔드로 실어 나르는 헤더. */
export function deviceHeader(token: string | undefined): Record<string, string> {
  return token ? { [DEVICE_TOKEN_HEADER]: token } : {};
}
