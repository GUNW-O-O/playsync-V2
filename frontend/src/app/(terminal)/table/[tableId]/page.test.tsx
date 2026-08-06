import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

// SeatGameClient는 'use client' 컴포넌트고 Felt·SeatActionPanel 등 브라우저
// 전용 의존성을 끌고 온다. 이 테스트가 보려는 건 page.tsx가 SeatGameClient에
// 넘기는 props뿐이므로, 실제 구현 대신 자리표시자로 바꿔 끌고 오는 것을
// 막는다. 목이라도 GamePage가 반환하는 React 엘리먼트의 props 객체는 그대로
// 보존되므로, 이 테스트의 핵심 단언(토큰 문자열이 안 실린다)에는 영향이 없다.
vi.mock('./SeatGameClient', () => ({ default: () => null }));

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
 * `SeatGameClient`로 내려가는 어떤 prop에도 실리지 않는다.
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

  it('accessToken 쿠키 값이 SeatGameClient에 넘어가는 props 어디에도 없다', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: LEAKED_ACCESS_TOKEN } : undefined,
    );

    const element = await GamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(JSON.stringify(element)).not.toContain(LEAKED_ACCESS_TOKEN);
  });

  it('dealerToken 쿠키 값도 SeatGameClient에 넘어가는 props 어디에도 없다', async () => {
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

  /**
   * 리뷰 지적(Important): `GET /tournaments/:id`는 `{ tournament, seatStatus }`
   * 봉투로 온다(`payment.service.ts`의 `getTournamentInfo`) — `storeId`는
   * `tournament.storeId`에 있다. 봉투를 안 벗기고 최상위에서 `.storeId`를
   * 읽으면 실제 성공 응답에서도 항상 undefined가 되고, 탈락한 참가자
   * 전원이 `/table?store=`(빈 값)로 보내진다.
   */
  it('GET /tournaments/:id 봉투를 벗겨 tournament.storeId를 SeatGameClient storeId prop으로 넘긴다', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: LEAKED_ACCESS_TOKEN } : undefined,
    );
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json({ seatIndex: 0, tableState: { pot: 0, tournamentId: 'trn-1' } }),
      ),
      http.get('http://backend.test/tournaments/trn-1', () =>
        HttpResponse.json({ tournament: { id: 'trn-1', storeId: 'store-9' }, seatStatus: [] }),
      ),
    );

    const element = await GamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(element.props.children.props.storeId).toBe('store-9');
  });

  /**
   * 리뷰 지적(Minor 1): `getStoreId`의 fetch가 네트워크 단절로 reject되면
   * 탈락 복귀 주소 하나를 못 구했다고 게임 화면 전체가 500이 되는 건
   * 균형이 안 맞는다. storeId 없이도(=undefined) 화면은 뜬다.
   */
  it('대회 정보 조회가 네트워크 실패해도 게임 화면은 그대로 뜬다', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: LEAKED_ACCESS_TOKEN } : undefined,
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get('http://backend.test/playsync/tbl-1', () =>
        HttpResponse.json({ seatIndex: 0, tableState: { pot: 0, tournamentId: 'trn-1' } }),
      ),
      http.get('http://backend.test/tournaments/trn-1', () => HttpResponse.error()),
    );

    // 던지지 않고 정상적으로 엘리먼트를 반환하는 것 자체가 이 테스트의 핵심이다.
    const element = await GamePage({ params: Promise.resolve({ tableId: 'tbl-1' }) });

    expect(element.props.children.props.storeId).toBeUndefined();
    errorSpy.mockRestore();
  });
});
