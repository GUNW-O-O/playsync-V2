/**
 * 토큰 쿠키의 수명을 **토큰 자신에게서** 뽑는다.
 *
 * 예전에는 세 곳이 각자 `maxAge: 60 * 60`을 적고 있었다. 그 값이 맞던 시절이
 * 있었는데(전역 JWT 만료가 한 시간이었다), T43이 수명을 역할별로 가르면서
 * (좌석·딜러·상점 콘솔 12시간, 그 밖 1시간) **한쪽만 바뀌었다.** 어긋난
 * 결과가 방향에 따라 다르게 아팠다.
 *
 * - 쿠키가 먼저 죽는 쪽(딜러·좌석 태블릿): 토큰이 열한 시간 더 살아 있는데
 *   태블릿이 한 시간 만에 자격을 잃는다. **T43이 없애려던 바로 그 증상**
 *   — 대회 도중 좌석마다 사람이 OTP를 다시 넣는 일 — 이 프론트에서 되살아났다.
 * - 쿠키가 더 오래 사는 쪽(`accessToken`, 하루): 죽은 토큰을 들고 스물세
 *   시간을 돌아다니며 401을 받는다.
 *
 * 값을 다시 베껴 맞추면 다음에 백엔드가 바꿀 때 같은 일이 또 난다. **어긋난
 * 것을 잡아 주는 장치가 없기 때문이다** — 타입 체커도 CI도 두 숫자를 대조하지
 * 않는다. 그래서 베끼지 않고 `exp`를 읽는다. 백엔드가 수명을 바꾸면 쿠키가
 * 저절로 따라간다.
 *
 * **서명은 검증하지 않는다.** 이 함수가 보는 토큰은 방금 우리 백엔드가 준
 * 것이고, 여기서 정하는 것은 권한이 아니라 **브라우저에 얼마나 보관할까**
 * 뿐이다. 위조된 `exp`로 얻을 수 있는 것은 자기 쿠키를 일찍 버리거나 오래
 * 들고 있는 것뿐이고, 토큰의 진짜 만료는 백엔드가 매 요청 검증한다.
 */

/** `exp`를 읽지 못했을 때. 예전에 세 곳이 쓰던 값이다. */
export const FALLBACK_MAX_AGE = 60 * 60;

export function cookieMaxAgeFromToken(token: string, now: number = Date.now()): number {
  const payload = token.split('.')[1];
  if (!payload) return FALLBACK_MAX_AGE;

  let exp: unknown;
  try {
    exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
  } catch {
    // 우리가 못 읽는 것과 토큰이 나쁜 것은 다르다. 여기서 던지면 로그인·입장이
    // 통째로 실패하는데, 토큰 자체는 유효할 수 있다.
    return FALLBACK_MAX_AGE;
  }

  if (typeof exp !== 'number' || !Number.isFinite(exp)) return FALLBACK_MAX_AGE;

  // 죽은 토큰은 저장하지 않는다. `maxAge: 0`이면 브라우저가 즉시 버리므로
  // 다음 요청이 "토큰 없음"으로 깨끗하게 갈린다.
  return Math.max(0, Math.floor(exp - now / 1000));
}
