// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { middleware, config } from '@/middleware';
import { SESSION_COOKIE, type Role } from '@/lib/session';

function makeToken(role: Role): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({
    sub: 'u1',
    nickname: 'n',
    role,
  })}.sig`;
}

function request(path: string, role?: Role): NextRequest {
  const req = new NextRequest(new URL(`http://localhost:3000${path}`));
  if (role) req.cookies.set(SESSION_COOKIE, makeToken(role));
  return req;
}

// NextResponse.next()와 "빈 본문으로 차단"은 둘 다 status 200이다.
// 통과 여부는 next()만 붙이는 이 헤더로만 갈린다. status만 보면
// 미들웨어가 막기 시작해도 테스트가 초록으로 남는다.
function expectPass(res: NextResponse): void {
  expect([res.status, res.headers.get('x-middleware-next')]).toEqual([200, '1']);
}

describe('미인증', () => {
  it('보호된 경로는 로그인으로 보낸다', () => {
    const res = middleware(request('/stores/s1'));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/stores/s1');
  });

  it('쿼리스트링까지 next에 담는다', () => {
    const res = middleware(request('/stores/s1?tab=members'));

    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('next')).toBe('/stores/s1?tab=members');
  });

  it('로그인 페이지는 통과시킨다', () => {
    expectPass(middleware(request('/login')));
  });

  it('좌석 태블릿은 통과시킨다', () => {
    expectPass(middleware(request('/table/t1')));
  });

  it('딜러 단말은 통과시킨다', () => {
    expectPass(middleware(request('/dealer/d1')));
  });
});

describe('역할 가드', () => {
  it('일반 유저는 어드민에 접근하면 404', () => {
    expect(middleware(request('/admin', 'USER')).status).toBe(404);
  });

  it('상점주는 어드민에 접근하면 404', () => {
    expect(middleware(request('/admin', 'STORE_ADMIN')).status).toBe(404);
  });

  it('플랫폼 운영자는 어드민을 통과한다', () => {
    expectPass(middleware(request('/admin', 'PLATFORM_ADMIN')));
  });

  it('일반 유저는 상점 콘솔에 접근하면 404', () => {
    expect(middleware(request('/stores/s1', 'USER')).status).toBe(404);
  });

  it('상점주는 상점 콘솔을 통과한다', () => {
    expectPass(middleware(request('/stores/s1', 'STORE_ADMIN')));
  });

  it('플랫폼 운영자도 상점 콘솔을 통과한다', () => {
    expectPass(middleware(request('/stores/s1', 'PLATFORM_ADMIN')));
  });

  it('일반 유저는 모바일 화면을 통과한다', () => {
    expectPass(middleware(request('/tournaments', 'USER')));
  });
});

// 미들웨어는 next.config의 rewrite보다 먼저 돈다. matcher가 /api를 잡으면
// 미인증 로그인 요청이 로그인 페이지로 307되고, 307은 메서드를 보존하므로
// 클라이언트는 JSON 대신 HTML을 받는다. 로그인 자체가 불가능해진다.
describe('matcher', () => {
  const matches = (pathname: string) =>
    new RegExp(`^${config.matcher[0]}$`).test(pathname);

  it('API 프록시 경로는 잡지 않는다', () => {
    expect(matches('/api/auth/login')).toBe(false);
  });

  it('확장자가 있는 정적 파일은 잡지 않는다', () => {
    expect([matches('/file.svg'), matches('/robots.txt')]).toEqual([
      false,
      false,
    ]);
  });

  it('보호 대상 페이지는 잡는다', () => {
    expect([matches('/stores/s1'), matches('/admin')]).toEqual([true, true]);
  });
});
