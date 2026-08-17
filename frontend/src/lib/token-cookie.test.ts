import { describe, it, expect } from 'vitest';
import { FALLBACK_MAX_AGE, cookieMaxAgeFromToken } from './token-cookie';

/** 서명은 검증하지 않으므로 아무 값이나 붙여도 된다 — 헤더도 마찬가지다. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

/**
 * **쿠키 수명을 상수로 적지 않는다.**
 *
 * T43이 토큰 수명을 역할별로 갈랐을 때(좌석·딜러·상점 12시간, 그 밖 1시간)
 * 프론트 쿠키는 따라가지 않았다. 세 곳이 전부 `maxAge: 60 * 60`이었고 주석까지
 * "백엔드 JWT 만료가 1시간이다"라고 적혀 있었다 — **한쪽만 고쳐도 아무 신호가
 * 나지 않는 자리다.** 그래서 값을 베끼는 대신 토큰이 들고 있는 `exp`에서
 * 뽑는다. 백엔드가 수명을 바꾸면 쿠키가 저절로 따라간다.
 */
describe('cookieMaxAgeFromToken', () => {
  const NOW = 1_700_000_000_000; // ms

  it('토큰의 exp까지 남은 초를 준다', () => {
    const token = tokenWith({ exp: NOW / 1000 + 12 * 60 * 60 });

    expect(cookieMaxAgeFromToken(token, NOW)).toBe(12 * 60 * 60);
  });

  it('역할이 달라 수명이 다르면 그대로 따라간다', () => {
    const short = tokenWith({ exp: NOW / 1000 + 60 * 60 });
    const long = tokenWith({ exp: NOW / 1000 + 12 * 60 * 60 });

    expect([cookieMaxAgeFromToken(short, NOW), cookieMaxAgeFromToken(long, NOW)])
      .toEqual([60 * 60, 12 * 60 * 60]);
  });

  /**
   * 죽은 토큰을 저장하지 않는다. `maxAge: 0`이면 브라우저가 쿠키를 즉시
   * 버리므로, 다음 요청이 "토큰 없음"으로 깨끗하게 갈린다 — 살아 있는 척하는
   * 쿠키를 들고 401을 받는 것보다 낫다.
   */
  it('이미 만료된 토큰은 0을 준다', () => {
    const token = tokenWith({ exp: NOW / 1000 - 1 });

    expect(cookieMaxAgeFromToken(token, NOW)).toBe(0);
  });

  /**
   * 파싱이 안 되는 경우는 기본값으로 떨어진다. 여기서 던지면 로그인·입장이
   * 통째로 실패하는데, 토큰 자체는 방금 백엔드가 준 유효한 값일 수 있다 —
   * 우리가 못 읽는 것과 토큰이 나쁜 것은 다르다.
   */
  it.each([
    ['점이 없다', 'not-a-jwt'],
    ['페이로드가 base64가 아니다', 'a.@@@.c'],
    ['페이로드가 JSON이 아니다', `a.${Buffer.from('hello').toString('base64url')}.c`],
    ['exp가 없다', tokenWith({ sub: 'u1' })],
    ['exp가 숫자가 아니다', tokenWith({ exp: 'soon' })],
    ['빈 문자열', ''],
  ])('읽을 수 없으면(%s) 기본값으로 떨어진다', (_label, token) => {
    expect(cookieMaxAgeFromToken(token, NOW)).toBe(FALLBACK_MAX_AGE);
  });
});
