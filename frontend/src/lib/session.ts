export const SESSION_COOKIE = 'accessToken';

export const ROLES = [
  'USER',
  'DEALER',
  'STORE_ADMIN',
  'PLATFORM_ADMIN',
] as const;

export type Role = (typeof ROLES)[number];

export type Session = {
  userId: string;
  nickname: string;
  role: Role;
};

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

// 이 함수는 미들웨어에서도 불린다. 미들웨어는 Edge 런타임에서 도는데 거기엔
// Buffer가 없으므로 atob으로 푼다. base64url은 문자 두 개가 다르고 패딩이
// 없으니 표준 base64로 되돌린 뒤 넘긴다.
function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);

  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// 서명은 검증하지 않는다. 프론트의 역할 판정은 어떤 화면을 보여줄지 정하는
// 데만 쓰고, 실제 권한은 백엔드가 판정한다. 여기서 검증하는 시늉을 하면
// 그것이 보안 경계인 것처럼 오해를 부른다.
export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;

  const { sub, nickname, role } = payload as Record<string, unknown>;

  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof nickname !== 'string' || nickname === '') return null;
  if (!isRole(role)) return null;

  return { userId: sub, nickname, role };
}
