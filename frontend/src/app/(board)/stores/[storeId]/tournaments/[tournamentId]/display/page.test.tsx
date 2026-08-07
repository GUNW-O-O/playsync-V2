import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Suspense } from 'react';
import TournamentDashboard from './page';

// 이 라우트의 세그먼트는 [storeId]/[tournamentId]다. `id`를 읽으면 undefined가
// URL에 박혀 전광판이 죽는데, Next 16의 페이지 검증 타입이 `& any`라 타입
// 체크로는 잡히지 않는다. 실제로 나가는 URL을 본다.
describe('전광판 화면', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('대회 조회 URL에 tournamentId 세그먼트를 쓴다', async () => {
    // 응답을 영원히 미뤄 폴링 타이머가 걸리지 않게 한다.
    const fetchSpy = vi.fn((..._args: unknown[]) => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchSpy);

    // params가 Promise라 첫 렌더가 suspend된다. act 안에서 풀어야 재개된다.
    await act(async () => {
      render(
        <Suspense>
          <TournamentDashboard
            params={Promise.resolve({ storeId: 'store-1', tournamentId: 'trnmt-9' })}
          />
        </Suspense>,
      );
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/playsync/dashboard/trnmt-9');
  });
});
