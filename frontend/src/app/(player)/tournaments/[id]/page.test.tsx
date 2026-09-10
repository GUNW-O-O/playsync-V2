import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

process.env.BACKEND_URL = 'http://backend.test';

// JoinPanel(클라이언트 컴포넌트)이 쓴다. 이 화면에서 참가 버튼을 눌러 보는
// 검사는 없으므로 라우터는 아무 동작도 하지 않으면 된다.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: TournamentDetailPage } = await import('./page');

/**
 * 응답 모양의 출처: `backend/src/payment/payment.service.ts`의
 * `getTournamentInfo`가 주는 `{ tournament, seatStatus }` 봉투 중
 * `tournament` 쪽. `page.tsx`의 `TournamentDetail`이 쓰는 것만 추린다.
 *
 * 중단·취소(`abortSession`·`cancelSession`)는 `isRegistrationOpen` 컬럼을
 * flip하지 않는다 — flip하는 곳은 `closeRegistration` 하나뿐이다. 그래서
 * `CANCELLED`인데 `isRegistrationOpen: true`인 조합이 실제로 나온다.
 */
const CANCELLED = {
  id: 't1',
  name: '중단된 토너먼트',
  status: 'CANCELLED',
  isRegistrationOpen: true,
  entryFee: 50000,
  startStack: 20000,
  rebuyUntil: 3,
  totalPlayers: 8,
  activePlayers: 0,
  storeId: 's1',
  blindStructure: null,
};

const FINISHED = {
  id: 't3',
  name: '지난주 토너먼트',
  status: 'FINISHED',
  isRegistrationOpen: false,
  entryFee: 50000,
  startStack: 20000,
  rebuyUntil: 3,
  totalPlayers: 8,
  activePlayers: 0,
  storeId: 's1',
  blindStructure: null,
};

const OPEN = {
  id: 't2',
  name: '금요일 프리즈아웃',
  status: 'PENDING',
  isRegistrationOpen: true,
  entryFee: 50000,
  startStack: 20000,
  rebuyUntil: 3,
  totalPlayers: 2,
  activePlayers: 2,
  storeId: 's1',
  blindStructure: null,
};

function renderPage(id: string) {
  return TournamentDetailPage({ params: Promise.resolve({ id }) });
}

describe('대회 상세', () => {
  it('취소된 대회는 참가 버튼이 죽어 있다', async () => {
    server.use(
      http.get('http://backend.test/tournaments/t1', () =>
        HttpResponse.json({ tournament: CANCELLED }),
      ),
    );

    render(await renderPage('t1'));

    expect(screen.getByRole('button', { name: /참가/ })).toBeDisabled();
  });

  it('취소된 대회는 「취소된 대회」로 적는다', async () => {
    server.use(
      http.get('http://backend.test/tournaments/t1', () =>
        HttpResponse.json({ tournament: CANCELLED }),
      ),
    );

    render(await renderPage('t1'));

    expect(screen.getByText('취소된 대회')).toBeInTheDocument();
    expect(screen.queryByText('등록 열림')).not.toBeInTheDocument();
  });

  it('종료된 대회는 「종료된 대회」로 적는다', async () => {
    // CANCELLED만 고정하면 「취소된 대회」·「종료된 대회」를 서로 바꿔 적어도
    // 이 파일이 전부 초록이다 — FINISHED가 CANCELLED보다 훨씬 흔한 상태라
    // 따로 고정한다.
    server.use(
      http.get('http://backend.test/tournaments/t3', () =>
        HttpResponse.json({ tournament: FINISHED }),
      ),
    );

    render(await renderPage('t3'));

    expect(screen.getByText('종료된 대회')).toBeInTheDocument();
    expect(screen.queryByText('취소된 대회')).not.toBeInTheDocument();
    expect(screen.queryByText('등록 열림')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /참가/ })).toBeDisabled();
  });

  it('등록이 열린 대회는 참가 버튼이 살아 있다', async () => {
    // 닫는 쪽만 검사하면 판정을 항상 참으로 접어도(`closed = true` 고정)
    // 앞 두 검사는 초록이다(T29) — 열린 쪽을 같이 고정해야 판정이 증명된다.
    server.use(
      http.get('http://backend.test/tournaments/t2', () =>
        HttpResponse.json({ tournament: OPEN }),
      ),
    );

    render(await renderPage('t2'));

    expect(screen.getByRole('button', { name: /참가/ })).not.toBeDisabled();
    expect(screen.getByText('등록 열림')).toBeInTheDocument();
  });
});
