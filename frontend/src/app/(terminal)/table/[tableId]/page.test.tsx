import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

// GameClient는 'use client' 컴포넌트고 PokerTable·ActionPanel 등 브라우저
// 전용 의존성을 끌고 온다. 이 테스트가 보려는 건 page.tsx가 GameClient에
// 넘기는 props뿐이므로, 실제 구현 대신 자리표시자로 바꿔 끌고 오는 것을
// 막는다. 목이라도 GamePage가 반환하는 React 엘리먼트의 props 객체는 그대로
// 보존되므로, 이 테스트의 핵심 단언(토큰 문자열이 안 실린다)에는 영향이 없다.
vi.mock('./GameClient', () => ({ default: () => null }));

const cookieStore = { get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: GamePage } = await import('./page');

const LEAKED_ACCESS_TOKEN = 'leaked-jwt-value';
const LEAKED_DEALER_TOKEN = 'leaked-dealer-jwt-value';

/**
 * 이 브랜치의 유일한 핵심 불변식: httpOnly 쿠키로 읽은 액세스 토큰이
 * `GameClient`로 내려가는 어떤 prop에도 실리지 않는다.
 *
 * `page.tsx`는 서버 컴포넌트다. Next App Router에서 서버 → 클라이언트 prop은
 * RSC 페이로드로 직렬화되어 페이지 HTML에 그대로 남는다(`view-source`로
 * 보인다) — httpOnly가 막는 것은 클라이언트 JS의 `document.cookie` 접근뿐이라,
 * prop으로 새면 httpOnly를 건 이유가 정면으로 무효화된다.
 *
 * 특정 prop 이름(`token`)을 짚지 않는다 — 이름을 바꿔 넣는 회귀도 잡아야
 * 하므로, 반환된 엘리먼트 트리를 직렬화해 토큰 문자열 자체가 어디에도
 * 없다는 것을 단언한다.
 */
describe('GamePage', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json({ seatIndex: 0, tableState: { pot: 0 } }),
      ),
    );
  });

  it('accessToken 쿠키 값이 GameClient에 넘어가는 props 어디에도 없다', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: LEAKED_ACCESS_TOKEN } : undefined,
    );

    const element = await GamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(JSON.stringify(element)).not.toContain(LEAKED_ACCESS_TOKEN);
  });

  it('dealerToken 쿠키 값도 GameClient에 넘어가는 props 어디에도 없다', async () => {
    // 딜러 토큰은 승자 지정 권한을 가진 토큰이다 — 새면 곧 돈이다.
    cookieStore.get.mockImplementation((name: string) =>
      name === 'dealerToken' ? { value: LEAKED_DEALER_TOKEN } : undefined,
    );
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json({ seatIndex: -1, tableState: { pot: 0 } }),
      ),
    );

    const element = await GamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(JSON.stringify(element)).not.toContain(LEAKED_DEALER_TOKEN);
  });
});
