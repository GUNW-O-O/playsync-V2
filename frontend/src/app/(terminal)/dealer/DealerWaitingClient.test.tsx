import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  /**
   * 딜러 OTP는 여섯 자리다(`DealerDto`의 `@Matches(/^[0-9]{6}$/)`). 참가
   * OTP(여덟 자리)와 다른 값이라, 상수를 안 보고 `otp.length === 0`만 보면
   * **어느 화면이든 한 자리로 제출된다**.
   */
  it('딜러 OTP가 여섯 자리가 아니면 제출되지 않는다', async () => {
    const authenticateDealer = vi.fn();
    render(
      <DealerWaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS}
        tables={TABLES}
        authenticateDealer={authenticateDealer}
      />,
    );

    for (const d of ['1', '2', '3', '4', '5']) {
      await userEvent.click(screen.getByRole('button', { name: d }));
    }
    expect(screen.getByRole('button', { name: /인증/ })).toBeDisabled();

    // 반대 입력. 없으면 "언제나 비활성"으로 고쳐도 위 단언이 초록이다.
    await userEvent.click(screen.getByRole('button', { name: '6' }));
    expect(screen.getByRole('button', { name: /인증/ })).not.toBeDisabled();
    expect(authenticateDealer).not.toHaveBeenCalled();
  });
});

/**
 * `WaitingClient.selectTournament`와 같은 모양의 결함이 여기에도 있었다 —
 * 같은 코드를 옮겨 온 자리라 같이 고친다. 딜러 화면은 테이블 목록이 낡으면
 * **없는 테이블에 인증을 시도**하게 된다.
 */
describe('DealerWaitingClient — 대회 전환', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TOURNAMENTS_MULTI = [
    { id: 't1', name: '데모 토너먼트', status: 'ONGOING' },
    { id: 't2', name: '두 번째 대회', status: 'ONGOING' },
  ];

  it('대회 전환이 네트워크 실패로 던져도 안내가 뜬다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    render(
      <DealerWaitingClient
        storeId="s1"
        tournaments={TOURNAMENTS_MULTI}
        tables={TABLES}
        authenticateDealer={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByTestId('pick-tournament-t2'));

    expect(
      await screen.findByText('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
    ).toBeInTheDocument();
  });
});
