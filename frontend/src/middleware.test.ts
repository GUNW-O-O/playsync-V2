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

  it('일반 유저는 내 참가 목록을 통과한다', () => {
    expectPass(middleware(request('/me', 'USER')));
  });

  // 상점 관리자는 상점 페이지를 관리하는 계정이지 참가자가 아니다. 백엔드는
  // 이미 그렇게 되어 있다 — 참가비 결제(`POST /tournaments/payment`)가
  // `@Roles(Role.USER)`이고, 좌석 입장의 자격 증명인 참가 OTP는 그 결제가
  // 발급한다. 화면만 열려 있어서 상점주가 참가자 화면에 들어간 뒤 버튼을
  // 눌러야 거절당했다.
  it('상점주는 모바일 화면에 접근하면 404', () => {
    expect(middleware(request('/tournaments', 'STORE_ADMIN')).status).toBe(404);
  });

  it('상점주는 내 참가 목록에 접근하면 404', () => {
    expect(middleware(request('/me', 'STORE_ADMIN')).status).toBe(404);
  });

  // 예전에는 빈 본문 404를 그대로 내보내 백지가 떴다. 상태 코드가 404라
  // 정보 노출 요건(그 자원이 존재한다는 사실을 숨긴다)은 이미 충족했으므로
  // 상태 코드는 그대로 두고 본문만 채운다.
  it('역할이 맞지 않으면 404를 유지하되 not-found 화면으로 rewrite한다', () => {
    const res = middleware(request('/stores/s1/tournaments/t1', 'USER'));

    expect(res.status).toBe(404);
    expect(res.headers.get('x-middleware-rewrite')).toContain('/_not-found');
  });
});

// 미들웨어는 next.config의 rewrite보다 먼저 돈다. matcher가 /api를 잡으면
// 미인증 로그인 요청이 로그인 페이지로 307되고, 307은 메서드를 보존하므로
// 클라이언트는 JSON 대신 HTML을 받는다. 로그인 자체가 불가능해진다.
// 여기서 손으로 컴파일한 RegExp는 근사치다. Next는 matcher를 path-to-regexp로
// 컴파일하므로 이 테스트는 Next의 실제 동작이 아니라 의도를 고정한다.
describe('matcher', () => {
  const matches = (pathname: string) =>
    new RegExp(`^${config.matcher[0]}$`).test(pathname);

  it('API 프록시 경로는 잡지 않는다', () => {
    expect(matches('/api/auth/login')).toBe(false);
  });

  it('확장자가 있는 정적 파일은 잡지 않는다', () => {
    expect([
      matches('/file.svg'),
      matches('/logo.svg'),
      matches('/robots.txt'),
      matches('/favicon.ico'),
    ]).toEqual([false, false, false, false]);
  });

  it('_next 내부 경로는 잡지 않는다', () => {
    expect([
      matches('/_next/static/chunks/main.js'),
      matches('/_next/image'),
    ]).toEqual([false, false]);
  });

  it('보호 대상 페이지는 잡는다', () => {
    expect([
      matches('/stores/s1'),
      matches('/admin'),
      matches('/tournaments'),
    ]).toEqual([true, true, true]);
  });

  // 동적 세그먼트에 점이 들어가도 가드는 돌아야 한다. 지금은 cuid라 점이 없지만
  // 상점 slug나 닉네임이 URL에 들어오는 순간 가드가 통째로 사라진다.
  it('동적 세그먼트에 점이 있어도 잡는다', () => {
    expect([matches('/stores/my.store'), matches('/admin/users/a.b')]).toEqual([
      true,
      true,
    ]);
  });

  /**
   * **루트 한 칸짜리 경로도 같다.** 위 테스트가 통과하는 이유는 `[^/]+`가
   * 슬래시를 못 넘어서라, 중첩된 경로만 지켜진다. 루트 바로 아래는 여전히
   * "점이 있으면 정적 파일"로 접혔다 — 지금은 그 자리에 동적 라우트가 없어
   * 악용할 수 없지만, `/[slug]`가 생기는 날 가드가 조용히 꺼진다.
   *
   * 그래서 판정을 **실제 자산 확장자 목록**으로 좁힌다. 점의 유무가 아니라
   * 무엇으로 끝나는가로 가른다.
   */
  it('루트 세그먼트에 점이 있어도 잡는다', () => {
    expect([matches('/my.store'), matches('/user.name')]).toEqual([true, true]);
  });
});
