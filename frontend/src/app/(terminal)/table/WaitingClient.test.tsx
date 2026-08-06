import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WaitingClient from './WaitingClient';

const TOURNAMENTS = [{ id: 't1', name: '데모 토너먼트', status: 'ONGOING' }];
const TABLES = [{ id: 'tb1', tableOrder: 1 }, { id: 'tb2', tableOrder: 2 }];

describe('WaitingClient', () => {
  it('점유된 자리는 누를 수 없다', async () => {
    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: [false, false, true, false, false, false, false, false, false] }]}
        enterSeat={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pick-seat-2')).toBeDisabled();
    expect(screen.getByTestId('pick-seat-3')).not.toBeDisabled();
  });

  it('409를 받으면 그 문구가 화면에 뜬다', async () => {
    const enterSeat = vi.fn().mockResolvedValue({ error: '이미 다른 참가자가 앉은 좌석입니다.' });
    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={enterSeat}
      />,
    );
    await userEvent.click(screen.getByTestId('pick-seat-3'));
    for (const d of ['1', '2', '3', '4', '5', '6']) {
      await userEvent.click(screen.getByRole('button', { name: d }));
    }
    await userEvent.click(screen.getByRole('button', { name: /참가/ }));
    await waitFor(() => {
      expect(screen.getByText('이미 다른 참가자가 앉은 좌석입니다.')).toBeInTheDocument();
    });
  });
});

// 대회 전환은 `page.tsx`가 미리 읽어 온 첫 대회를 넘어 클라이언트에서
// `/api/dealer/:id`·`/api/tournaments/:id/seats`를 다시 읽는 경로다(리뷰
// Important 1·2). 이 두 테스트는 서로 다른 입력으로 서로 다른 버그를 잡는다:
// 레이스 테스트는 응답 순서를 뒤집어야만 실패하고, 정상 전환 테스트는 응답이
// 제때 와도 상태가 안 바뀌면 실패한다 — 하나만 있으면 다른 하나가 깨져도
// 모른다.
describe('WaitingClient — 대회 전환', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TOURNAMENTS_MULTI = [
    { id: 't1', name: '데모 토너먼트', status: 'ONGOING' },
    { id: 't2', name: '두 번째 대회', status: 'ONGOING' },
    { id: 't3', name: '세 번째 대회', status: 'ONGOING' },
  ];

  /**
   * `fetch`를 손으로 조종할 수 있게 목한다. `respond`를 부르기 전까지는
   * 어떤 fetch도 resolve되지 않는다 — 두 요청의 응답 순서를 테스트가
   * 직접 정하기 위해서다(msw는 순서를 이 정도로 세밀하게 못 다룬다).
   */
  function stubControlledFetch() {
    const pending: Record<string, ((value: unknown) => void)[]> = {};
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise((resolve) => {
          // 클라이언트 조회는 `apiFetch`를 지나므로 오리진이 앞에 붙어
          // 나간다(`lib/api.ts` + `vitest.setup.ts`). 테스트는 경로로만
          // 응답을 짚는다 — 오리진은 이 테스트가 보려는 것이 아니다.
          const path = url.replace(process.env.NEXT_PUBLIC_API_BASE ?? '', '');
          (pending[path] ??= []).push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    return {
      respond(url: string, body: unknown) {
        const resolve = pending[url]?.shift();
        if (!resolve) throw new Error(`${url}로 온 대기 중인 fetch가 없다`);
        resolve({ ok: true, json: async () => body });
      },
    };
  }

  it('빠르게 두 번 전환하면 먼저 고른 대회의 늦은 응답이 화면을 덮지 않는다', async () => {
    const { respond } = stubControlledFetch();

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));
    await userEvent.click(screen.getByTestId('pick-tournament-t3'));

    // 나중에 고른 t3의 응답이 먼저 도착한다.
    respond('/api/dealer/t3', { tables: [{ id: 'tb-t3', tableOrder: 9 }] });
    respond('/api/tournaments/t3/seats', [{ tableId: 'tb-t3', seatStatus: Array(9).fill(false) }]);
    await waitFor(() => expect(screen.getByTestId('pick-table-tb-t3')).toBeInTheDocument());

    // 먼저 고른(이미 버려진) t2의 응답이 나중에 도착한다.
    respond('/api/dealer/t2', { tables: [{ id: 'tb-t2', tableOrder: 5 }] });
    respond('/api/tournaments/t2/seats', [{ tableId: 'tb-t2', seatStatus: Array(9).fill(false) }]);

    // 화면은 여전히 마지막으로 고른 t3여야 한다 — t2의 낡은 응답이 덮으면 안 된다.
    await waitFor(() => {
      expect(screen.queryByTestId('pick-table-tb-t2')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('pick-table-tb-t3')).toBeInTheDocument();
  });

  it('두 번째 대회를 고르면 그 대회의 테이블과 좌석 도식으로 바뀐다', async () => {
    const { respond } = stubControlledFetch();

    render(
      <WaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        seatMap={[{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]}
        enterSeat={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pick-table-tb1')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));
    respond('/api/dealer/t2', { tables: [{ id: 'tb-second', tableOrder: 3 }] });
    respond('/api/tournaments/t2/seats', [
      { tableId: 'tb-second', seatStatus: [true, false, false, false, false, false, false, false, false] },
    ]);

    await waitFor(() => expect(screen.getByTestId('pick-table-tb-second')).toBeInTheDocument());
    expect(screen.queryByTestId('pick-table-tb1')).not.toBeInTheDocument();
    expect(screen.getByTestId('pick-seat-0')).toBeDisabled();
  });
});
