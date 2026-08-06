import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JoinPanel from './JoinPanel';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

describe('JoinPanel', () => {
  beforeEach(() => {
    push.mockReset();
  });

  it('참가에 실패하면 서버가 준 문구를 그대로 띄운다', async () => {
    // 문구의 출처: `backend/src/payment/payment.service.ts:82-84`.
    const joinTournament = vi.fn().mockResolvedValue({ error: '포인트가 부족합니다.' });
    render(<JoinPanel tournamentId="t1" entryFee={50000} joinTournament={joinTournament} />);

    await userEvent.click(screen.getByRole('button', { name: /참가/ }));

    await waitFor(() => {
      expect(screen.getByText('포인트가 부족합니다.')).toBeInTheDocument();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('참가에 성공하면 참가 OTP를 볼 수 있는 화면으로 보낸다', async () => {
    // 결제 응답에는 OTP가 없다(`joinSession`은 `{ id, status }`만 준다).
    // OTP를 읽는 곳은 `/me` 하나뿐이라 거기로 보낸다.
    const joinTournament = vi.fn().mockResolvedValue({ ok: true });
    render(<JoinPanel tournamentId="t1" entryFee={50000} joinTournament={joinTournament} />);

    await userEvent.click(screen.getByRole('button', { name: /참가/ }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/me');
    });
    expect(joinTournament).toHaveBeenCalledWith('t1');
  });
});
