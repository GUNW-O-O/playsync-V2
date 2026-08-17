import { NextResponse, type NextRequest } from 'next/server';
import { decodeSession, SESSION_COOKIE, type Role } from '@/lib/session';

// 로그인 없이 열리는 경로. 단말은 사용자 로그인이 아니라 OTP로 진입한다.
const PUBLIC_PREFIXES = ['/login', '/register', '/table', '/dealer'];

// 경로별로 요구하는 역할. 앞에서부터 처음 걸리는 것이 적용된다.
//
// 참가자 화면(`/tournaments`·`/me`)이 USER 전용인 이유는, 상점 관리자가
// 상점 페이지를 관리하는 계정이지 참가자가 아니기 때문이다. 백엔드는 이미
// 그렇게 되어 있었다 — 참가비 결제(`POST /tournaments/payment`)가
// `@Roles(Role.USER)`이고, 좌석 입장의 자격 증명인 참가 OTP는 그 결제가
// 발급한다. 화면만 열려 있어서 상점주가 참가자 화면에 들어간 다음 버튼을
// 눌러야 거절당했다. 역할의 진실은 여전히 백엔드지만, 애초에 못 가는 화면을
// 열어 두면 그 화면은 상점주에게 고장난 것으로 보인다.
const ROLE_RULES: { prefix: string; allow: readonly Role[] }[] = [
  { prefix: '/admin', allow: ['PLATFORM_ADMIN'] },
  { prefix: '/stores', allow: ['STORE_ADMIN', 'PLATFORM_ADMIN'] },
  { prefix: '/tournaments', allow: ['USER'] },
  { prefix: '/me', allow: ['USER'] },
];

function startsWithSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => startsWithSegment(pathname, p))) {
    return NextResponse.next();
  }

  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (!session) {
    const loginUrl = new URL('/login', request.url);
    // 쿼리까지 담아야 로그인 후 원래 보던 화면 그대로 돌아온다.
    loginUrl.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  const rule = ROLE_RULES.find((r) => startsWithSegment(pathname, r.prefix));

  // 역할이 맞지 않으면 404다. 403은 그 자원이 존재한다는 사실을 알려준다.
  // 상태 코드는 그대로 두고 본문만 채운다 — 빈 본문이면 백지가 뜬다.
  if (rule && !rule.allow.includes(session.role)) {
    return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
  }

  return NextResponse.next();
}

// 미들웨어는 next.config의 rewrite보다 먼저 돈다. /api를 빼지 않으면 미인증
// 로그인 요청이 여기서 307로 잡히고, 307은 메서드를 보존하므로 클라이언트는
// JSON 대신 로그인 페이지 HTML을 받는다. 로그인 자체가 성립하지 않는다.
//
// 확장자가 있는 경로는 public/의 정적 파일이다. 가드에 걸리면 로그인 화면의
// 이미지마다 307이 돌아온다. 다만 확장자 판정은 끝에 붙들어 둔다 — `.*\.`이면
// 경로 어디든 점 하나로 가드가 통째로 빠지고, slug나 닉네임이 URL에 들어오는
// 순간 그대로 열린다.
export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|[^/]+\\.[a-zA-Z0-9]+$).*)',
  ],
};
