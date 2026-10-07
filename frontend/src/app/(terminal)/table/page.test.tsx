import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// T112. 기기 토큰 쿠키. 기본은 이 상점의 기기 토큰이라 기존 케이스가 그대로 돈다.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (payload: unknown) => `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
let current: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (n === 'deviceToken' && current ? { value: current } : undefined),
  }),
}));
// 등록 폼은 useRouter를 쓴다. 이 파일이 보는 것은 어느 쪽을 그리느냐뿐이다.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

process.env.BACKEND_URL = 'http://backend.test';

const { default: SeatWaitingPage } = await import('./page');

const STORE = 'store-1';

beforeEach(() => {
  current = token({ role: 'STORE_DEVICE', storeId: STORE });
});
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

describe('SeatWaitingPage — 기기 등록(T112)', () => {
  it('기기 토큰이 없으면 등록 폼을 그린다', async () => {
    current = undefined;
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.getByRole('heading', { name: '매장 태블릿 등록' })).toBeInTheDocument();
  });

  it('다른 상점의 기기 토큰이면 등록 폼을 그린다', async () => {
    current = token({ role: 'STORE_DEVICE', storeId: 'store-2' });
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.getByRole('heading', { name: '매장 태블릿 등록' })).toBeInTheDocument();
  });

  it('이 상점의 기기 토큰이면 대기 화면을 그린다', async () => {
    mockTournaments(200, []);
    current = token({ role: 'STORE_DEVICE', storeId: 'store-1' });
    render(await SeatWaitingPage({ searchParams: Promise.resolve({ store: 'store-1' }) }));
    expect(screen.queryByRole('heading', { name: '매장 태블릿 등록' })).not.toBeInTheDocument();
  });
});
