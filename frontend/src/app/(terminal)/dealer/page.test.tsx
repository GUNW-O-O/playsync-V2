import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';

// DealerWaitingClient도 'use client'다 — table/page.test.tsx와 같은 이유로
// 자리표시자로 바꾼다.
vi.mock('./DealerWaitingClient', () => ({
  default: () => <div data-testid="dealer-waiting-client" />,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: DealerWaitingPage } = await import('./page');

const STORE = 'store-1';
const TOURNAMENT = 'tournament-1';

function mockTournaments(status: number, body: object) {
  server.use(
    http.get(`http://backend.test/tournaments/stores/${STORE}`, () =>
      HttpResponse.json(body, { status }),
    ),
  );
}

/**
 * m2(최종 리뷰). `table/page.test.tsx`와 같은 이유 — 이 파일은 조회
 * 두 자리에 각자 `isServerRecovering` 분기를 갖는다.
 */
describe('DealerWaitingPage — 서버 장애(T97)', () => {
  it('대회 목록 조회가 503이면 복구 문구를 그리고 DealerWaitingClient는 그리지 않는다', async () => {
    mockTournaments(503, { statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' });

    const element = await DealerWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('dealer-waiting-client')).not.toBeInTheDocument();
  });

  it('딜러 세션 조회가 503이면 복구 문구를 그린다', async () => {
    mockTournaments(200, [{ id: TOURNAMENT, name: '대회', status: 'ONGOING' }]);
    server.use(
      http.get(`http://backend.test/dealer/${TOURNAMENT}`, () =>
        HttpResponse.json({ statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }, { status: 503 }),
      ),
    );

    const element = await DealerWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('dealer-waiting-client')).not.toBeInTheDocument();
  });

  /** 반대 입력. 404 등 장애가 아닌 실패는 기존처럼 빈 목록으로 접혀 화면이 뜬다. */
  it('대회 목록 조회가 404면 복구 문구 없이 화면을 그린다(반대 입력)', async () => {
    mockTournaments(404, { statusCode: 404, message: 'Not Found' });

    const element = await DealerWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.queryByText(SERVER_RECOVERING_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByTestId('dealer-waiting-client')).toBeInTheDocument();
  });
});
