import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

process.env.BACKEND_URL = 'http://backend.test';

const { default: TournamentsPage } = await import('./page');

/**
 * 응답 모양의 출처: `backend/src/payment/payment.service.ts`의
 * `getStoreAvailableSessions`. 지금은 `PENDING`·`ONGOING`만 주므로
 * `CANCELLED`가 오는 것은 **조회가 걸러 준다는 전제가 깨졌을 때**다 — 그
 * 전제가 사실인 동안은 도달 불가지만, 화면의 판정 자체가 옳은지는 조회와
 * 별개로 검사한다(`page.tsx`의 `open` 판정 옆 주석과 같은 이유).
 */
const CANCELLED = {
  id: 't1',
  name: '중단된 토너먼트',
  status: 'CANCELLED',
  isRegistrationOpen: true,
  entryFee: 50000,
  startStack: 20000,
  totalPlayers: 8,
};

const OPEN = {
  id: 't2',
  name: '금요일 프리즈아웃',
  status: 'PENDING',
  isRegistrationOpen: true,
  entryFee: 50000,
  startStack: 20000,
  totalPlayers: 2,
};

/**
 * 마감 레벨을 지났지만 대회는 여전히 진행 중인 경우다(T90). `open` 판정은
 * `isRegistrationOpen && !isClosedStatus`인데 `ONGOING`은 닫힌 상태가
 * 아니므로 판정은 오직 `isRegistrationOpen`에 달렸다. 이 화면은 상세와
 * 달리 「취소된 대회」/「종료된 대회」로 문구를 가르지 않고 「등록 마감」
 * 하나로 뭉친다(page.tsx의 `open` 판정 옆 주석) — 그래서 여기서 지키는
 * 것은 그 두 갈래 문구뿐이다.
 */
const ONGOING_PAST_DEADLINE = {
  id: 't4',
  name: '진행 중 프리즈아웃',
  status: 'ONGOING',
  isRegistrationOpen: false,
  entryFee: 50000,
  startStack: 20000,
  totalPlayers: 6,
};

function mockStore(tournaments: unknown[]) {
  server.use(
    http.get('http://backend.test/tournaments/stores', () =>
      HttpResponse.json([{ id: 's1', name: '테스트 상점' }]),
    ),
    http.get('http://backend.test/tournaments/stores/s1', () =>
      HttpResponse.json(tournaments),
    ),
  );
}

/**
 * `store` 파라미터가 있으면 `TournamentsPage`는 `<StoreTournaments />`
 * 하나만 돌려준다 — 그 자체가 또 다른 async 서버 컴포넌트라
 * `render(await TournamentsPage(...))`만으로는 안까지 그려지지 않는다
 * (testing-library가 아는 것은 클라이언트 엘리먼트 트리뿐이다). 한 겹 더
 * 직접 호출해 실제로 그릴 JSX까지 푼다.
 */
async function renderStore() {
  const element = await TournamentsPage({ searchParams: Promise.resolve({ store: 's1' }) });
  return typeof element.type === 'function' ? await element.type(element.props) : element;
}

describe('대회 찾기 — 상점의 대회 목록', () => {
  it('닫힌 대회가 목록에 오면 열림으로 그리지 않는다', async () => {
    mockStore([CANCELLED]);

    render(await renderStore());

    expect(screen.getByText('중단된 토너먼트')).toBeInTheDocument();
    expect(screen.queryByText('등록 열림')).not.toBeInTheDocument();
  });

  it('열린 대회는 열림으로 그린다', async () => {
    // 닫힌 쪽만 검사하면 판정을 항상 거짓으로 접어도(`open = false` 고정)
    // 위 검사는 초록이다(T29) — 열린 쪽을 같이 고정해야 판정이 증명된다.
    mockStore([OPEN]);

    render(await renderStore());

    expect(screen.getByText('등록 열림')).toBeInTheDocument();
  });

  it('진행 중이어도 마감 레벨을 지났으면 「등록 마감」으로 그린다', async () => {
    mockStore([ONGOING_PAST_DEADLINE]);

    render(await renderStore());

    expect(screen.getByText('등록 마감')).toBeInTheDocument();
    expect(screen.queryByText('등록 열림')).not.toBeInTheDocument();
  });
});
