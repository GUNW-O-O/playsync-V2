import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DealerWaitingClient from './DealerWaitingClient';

// 지운 `dealer/[id]/page.test.tsx`가 보던 세 단언(라우팅·인자 전달·에러
// 표시) 중 라우팅과 에러 표시를 여기로 옮긴다. `authenticateDealer`는 이제
// 서버 액션 import가 아니라 prop이라 모듈 mock 없이 그대로 `vi.fn()`을
// 넘긴다 — `page.tsx`가 실제로 넘기는 함수와 같은 자리다.
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const TOURNAMENTS = [{ id: 't1', name: '데모 토너먼트', status: 'ONGOING' }];
const TABLES = [{ id: 'tb1', tableOrder: 1 }];

async function fillOtpAndSubmit() {
  for (const d of ['1', '2', '3', '4', '5', '6']) {
    await userEvent.click(screen.getByRole('button', { name: d }));
  }
  await userEvent.click(screen.getByRole('button', { name: /인증/ }));
}

describe('DealerWaitingClient', () => {
  beforeEach(() => {
    push.mockClear();
  });

  it('인증에 성공하면 그 테이블의 딜러 게임 화면으로 보낸다', async () => {
    const authenticateDealer = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DealerWaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        authenticateDealer={authenticateDealer}
      />,
    );

    await fillOtpAndSubmit();

    expect(authenticateDealer).toHaveBeenCalledWith({ tournamentId: 't1', tableId: 'tb1', otp: '123456' });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dealer/table/tb1'));
  });

  it('실패하면 백엔드 문구를 그대로 보여주고 화면을 옮기지 않는다', async () => {
    // 딜러 auth 실패의 네 가지 갈래(401·403 시도초과·403 종료된 대회·409
    // 세션 미준비) 중 어느 것이든 화면은 그 문구를 그대로 보여줘야 한다
    // (`dealer/action.ts`의 근거와 같다).
    const authenticateDealer = vi.fn().mockResolvedValue({
      error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
    });
    render(
      <DealerWaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        authenticateDealer={authenticateDealer}
      />,
    );

    await fillOtpAndSubmit();

    await waitFor(() => {
      expect(
        screen.getByText('인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.'),
      ).toBeInTheDocument();
    });
    expect(push).not.toHaveBeenCalled();
  });
});
