import { NextResponse, type NextRequest } from 'next/server';
import { decodeSession, SESSION_COOKIE, type Role } from '@/lib/session';

// 로그인 없이 열리는 경로. 단말은 사용자 로그인이 아니라 OTP로 진입한다.
const PUBLIC_PREFIXES = ['/login', '/register', '/table', '/dealer'];

// 경로별로 요구하는 역할. 앞에서부터 처음 걸리는 것이 적용된다.
const ROLE_RULES: { prefix: string; allow: readonly Role[] }[] = [
  { prefix: '/admin', allow: ['PLATFORM_ADMIN'] },
  { prefix: '/stores', allow: ['STORE_ADMIN', 'PLATFORM_ADMIN'] },
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
  if (rule && !rule.allow.includes(session.role)) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

// 미들웨어는 next.config의 rewrite보다 먼저 돈다. /api를 빼지 않으면 미인증
// 로그인 요청이 여기서 307로 잡히고, 307은 메서드를 보존하므로 클라이언트는
// JSON 대신 로그인 페이지 HTML을 받는다. 로그인 자체가 성립하지 않는다.
//
// 확장자가 있는 경로는 public/의 정적 파일이다. 가드에 걸리면 로그인 화면의
// 이미지마다 307이 돌아온다.
export const config = {
  matcher: ['/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
