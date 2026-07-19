// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
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

describe('미인증', () => {
  it('보호된 경로는 로그인으로 보낸다', () => {
    const res = middleware(request('/stores/s1'));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/stores/s1');
  });

  it('로그인 페이지는 통과시킨다', () => {
    expect(middleware(request('/login')).status).toBe(200);
  });

  it('좌석 태블릿은 통과시킨다', () => {
    expect(middleware(request('/table/t1')).status).toBe(200);
  });

  it('딜러 단말은 통과시킨다', () => {
    expect(middleware(request('/dealer/d1')).status).toBe(200);
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
    expect(middleware(request('/admin', 'PLATFORM_ADMIN')).status).toBe(200);
  });

  it('일반 유저는 상점 콘솔에 접근하면 404', () => {
    expect(middleware(request('/stores/s1', 'USER')).status).toBe(404);
  });

  it('상점주는 상점 콘솔을 통과한다', () => {
    expect(middleware(request('/stores/s1', 'STORE_ADMIN')).status).toBe(200);
  });

  it('플랫폼 운영자도 상점 콘솔을 통과한다', () => {
    expect(middleware(request('/stores/s1', 'PLATFORM_ADMIN')).status).toBe(200);
  });

  it('일반 유저는 모바일 화면을 통과한다', () => {
    expect(middleware(request('/tournaments', 'USER')).status).toBe(200);
  });
});
