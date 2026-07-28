import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { WsTicketResponseSchema } from '@playsync/contract';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/**
 * WS 핸드셰이크용 티켓을 대신 받아온다.
 *
 * **액세스 토큰이 브라우저로 내려가지 않게 하는 것이 이 파일의 존재 이유다.**
 * 쿠키는 httpOnly라 클라이언트 JS가 읽지 못하고, 서버 컴포넌트가 prop으로
 * 내려보내면 RSC 페이로드에 실려 페이지 소스에 그대로 남는다. 그래서 토큰을
 * 읽는 일을 여기 한 곳에 가두고, 밖으로는 티켓만 내보낸다.
 */
export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value ?? cookieStore.get('accessToken')?.value;

  if (!token) {
    return NextResponse.json({ message: '인증이 필요합니다.' }, { status: 401 });
  }

  const res = await fetch(`${BACKEND_URL}/ws/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = (body as { message?: unknown } | null)?.message;
    return NextResponse.json(
      { message: typeof message === 'string' ? message : '티켓을 받지 못했습니다.' },
      { status: res.status },
    );
  }

  // 백엔드 본문을 그대로 흘려보내지 않는다. contract 스키마로 parse해야
  // 스키마에 없는 키(예: 실수로 실린 accessToken)가 실제로 스트립된다 —
  // ws-ticket.ts의 주석이 말하는 "마지막 그물"은 여기서 실행돼야 사실이 된다.
  try {
    const parsed = WsTicketResponseSchema.parse(body);
    return NextResponse.json(parsed);
  } catch {
    // 백엔드가 ticket을 안 줬거나 모양이 다르다. 액세스 토큰이 새지 않는
    // 응답이면 되므로 본문은 담지 않는다.
    return NextResponse.json({ message: '티켓 응답 형식이 올바르지 않습니다.' }, { status: 502 });
  }
}
