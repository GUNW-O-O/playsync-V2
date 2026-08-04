import { describe, it, expect, vi } from 'vitest';
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
