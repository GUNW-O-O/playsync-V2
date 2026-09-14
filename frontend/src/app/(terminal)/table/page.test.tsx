import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';

// WaitingClient는 'use client' 컴포넌트고 폴링·Keypad 등 브라우저 전용
// 동작을 끈다. 이 테스트가 보려는 것은 page.tsx의 세 조회가 503을 어떻게
// 가르는지뿐이므로, 실제 구현 대신 자리표시자로 바꿔 무관한 렌더를 막는다.
vi.mock('./WaitingClient', () => ({
  default: () => <div data-testid="waiting-client" />,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: SeatWaitingPage } = await import('./page');

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
 * m2(최종 리뷰). 이 파일은 세 조회를 순서대로 하고 조회마다 자기만의
 * `isServerRecovering` 분기를 갖는다 — 하나라도 지우면 그 조회의 503이
 * `miss`로 접혀 빈 화면이 조용히 뜬다(504 등 진짜 원인 불명 실패와 같은
 * 문구가 되어 버린다).
 */
describe('SeatWaitingPage — 서버 장애(T97)', () => {
  it('대회 목록 조회가 503이면 복구 문구를 그리고 WaitingClient는 그리지 않는다', async () => {
    mockTournaments(503, { statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' });

    const element = await SeatWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-client')).not.toBeInTheDocument();
  });

  it('딜러 세션 조회가 503이면 복구 문구를 그린다', async () => {
    mockTournaments(200, [{ id: TOURNAMENT, name: '대회', status: 'ONGOING' }]);
    server.use(
      http.get(`http://backend.test/dealer/${TOURNAMENT}`, () =>
        HttpResponse.json({ statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }, { status: 503 }),
      ),
      http.get(`http://backend.test/tournaments/${TOURNAMENT}/seats`, () => HttpResponse.json([])),
    );

    const element = await SeatWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-client')).not.toBeInTheDocument();
  });

  it('좌석 현황 조회가 503이면 복구 문구를 그린다', async () => {
    mockTournaments(200, [{ id: TOURNAMENT, name: '대회', status: 'ONGOING' }]);
    server.use(
      http.get(`http://backend.test/dealer/${TOURNAMENT}`, () => HttpResponse.json({ tables: [] })),
      http.get(`http://backend.test/tournaments/${TOURNAMENT}/seats`, () =>
        HttpResponse.json({ statusCode: 503, message: SERVER_RECOVERING_MESSAGE, error: 'Service Unavailable' }, { status: 503 }),
      ),
    );

    const element = await SeatWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.getByText(SERVER_RECOVERING_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-client')).not.toBeInTheDocument();
  });

  /** 반대 입력. 404 등 장애가 아닌 실패는 기존처럼 빈 목록으로 접혀 화면이 뜬다. */
  it('대회 목록 조회가 404면 복구 문구 없이 화면을 그린다(반대 입력)', async () => {
    mockTournaments(404, { statusCode: 404, message: 'Not Found' });

    const element = await SeatWaitingPage({ searchParams: Promise.resolve({ store: STORE }) });
    render(element);

    expect(screen.queryByText(SERVER_RECOVERING_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByTestId('waiting-client')).toBeInTheDocument();
  });
});
