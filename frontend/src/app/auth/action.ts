'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { decodeSession, SESSION_COOKIE, type Session } from '@/lib/session';
import { cookieMaxAgeFromToken } from '@/lib/token-cookie';
import { failureMessage } from '@/lib/failure-message';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/**
 * 요청율 상한(429) 전용 안내문. 백엔드 본문의 `message`는 남은 초를 안 들고
 * 있어(`backend/src/auth/throttle.ts`의 `ERROR_MESSAGE`) 여기서 따로 만든다(T92).
 *
 * 남은 시간은 서버가 `Retry-After` 헤더로 들고 있다 — 화면이 숫자를 지어내지
 * 않고 그 헤더를 읽는다. 헤더가 없거나(프록시가 걸러내는 경우) HTTP-date
 * 형식이면 `Number`가 NaN을 내고, `Number.isFinite`가 그것을 걸러 초 없는
 * 문장으로 떨어진다.
 *
 * **주어를 쓰지 않는다.** `handleRegister`도 이 함수를 쓰는데 `/auth/join`은
 * 자기 버킷이라(Nest의 `generateKey`가 핸들러 이름을 키에 넣는다) "로그인"이
 * 틀린 말이 된다.
 */
function throttleMessage(res: Response): string {
  const retryAfter = Number(res.headers.get('Retry-After'));
  const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `${retryAfter}초 뒤` : '잠시 후';
  return `요청이 많아 잠시 막혔습니다. ${wait} 다시 시도해 주세요.`;
}

// [회원가입 Action]
export async function handleRegister(formData: FormData) {
  const password = formData.get('password');
  const nickname = formData.get('nickname');

  const res = await fetch(`${BACKEND_URL}/auth/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });

  if (!res.ok) {
    if (res.status === 429) return { error: throttleMessage(res) };
    const body = await res.json().catch(() => null);
    return { error: failureMessage(body, '회원가입에 실패했습니다.') };
  }

  redirect('/login');
}

// [로그인 Action]
export async function handleLogin(formData: FormData) {
  const nickname = formData.get('nickname');
  const password = formData.get('password');
  const cookie = await cookies();

  const res = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });

  // **파싱이 던지지 않게 한다.** 본문을 `res.ok`보다 먼저 읽지만
  // `.catch(() => null)`이 받으므로, JSON이 아닌 실패 응답에서도 이 액션이
  // 던지지 않고 기본 문구로 떨어진다(위 `failureMessage`).
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 429) return { error: throttleMessage(res) };
    return { error: failureMessage(data, '아이디 또는 비밀번호가 틀렸습니다.') };
  }
  if (!data) {
    // 200인데 본문을 못 읽었다. 아래에서 `data.accessToken`이 던지느니
    // 같은 문구로 돌려보낸다 — 참가자에게는 로그인이 안 된 것이 전부다.
    return { error: '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
  }

  // 데이터 구조가 { accessToken: '...' } 라고 가정
  const token = data.accessToken;

  // [핵심] 쿠키에 JWT 저장
  cookie.set(SESSION_COOKIE, token, {
    httpOnly: true, // 자바스크립트로 접근 불가 (보안)
    secure: process.env.NODE_ENV === 'production', // HTTPS에서만 전송
    sameSite: 'lax', // CSRF 방어
    path: '/', // 모든 경로에서 쿠키 유효
    // 하루로 박혀 있었다. 토큰은 역할에 따라 1시간(USER)이거나 12시간
    // (STORE_ADMIN)이라(`auth/token-ttl.ts`), 참가자는 죽은 토큰을 스물세
    // 시간 들고 다니며 401을 받았다. 수명은 토큰이 정한다.
    maxAge: cookieMaxAgeFromToken(token),
  });

  redirect(landingPath(formData.get('next'), decodeSession(token)));
}

/**
 * 로그인 뒤에 갈 곳.
 *
 * 예전에는 무조건 `/`였는데, `app/page.tsx`가 `/`를 다시 `/login`으로
 * 보낸다. **로그인 버튼을 눌러도 로그인 화면이 그대로 다시 뜨는** 상태였다
 * (e2e가 URL 대신 쿠키로 완료를 기다리는 것도 이 때문이다).
 *
 * 순서는 이렇다.
 *
 * 1. 미들웨어가 붙여 준 `next` — 원래 보려던 화면으로 돌려보낸다.
 * 2. 없으면 역할의 홈. 지금 홈이 있는 역할은 참가자(USER)뿐이다.
 * 3. 그 외에는 `/`. 상점·플랫폼 관리자의 홈 화면은 아직 없고,
 *    없는 경로를 여기서 지어내면 로그인이 404로 끝난다.
 */
function landingPath(next: FormDataEntryValue | null, session: Session | null): string {
  // 오픈 리다이렉트를 막는다. `//evil.example`은 프로토콜 상대 URL이라
  // 슬래시로 시작하는지만 보면 외부로 나간다. `/\`도 일부 브라우저가
  // 같은 것으로 읽는다.
  if (typeof next === 'string' && /^\/(?![/\\])/.test(next)) {
    return next;
  }
  if (session?.role === 'USER') return '/me';
  return '/';
}