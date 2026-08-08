import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConsoleClient, { type TournamentMeta } from './ConsoleClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const TOURNAMENT: TournamentMeta = {
  id: 'trn-1',
  name: '데모 토너먼트',
  status: 'PENDING',
  isRegistrationOpen: true,
  rebuyUntil: 4,
  entryFee: 50000,
  startStack: 5000,
};

function renderConsole(reissue = vi.fn(async () => ({ ok: true as const, dealerOtp: '920576' }))) {
  render(
    <ConsoleClient
      storeId="store-1"
      tournamentId="trn-1"
      tournament={TOURNAMENT}
      dashboard={null}
      tables={[{ id: 'tbl-1', tableOrder: 1 }]}
      seatOccupants={[{ tableId: 'tbl-1', tableOrder: 1, players: [] }]}
      seatError={null}
      startTournament={vi.fn(async () => ({ ok: true as const }))}
      openTable={vi.fn(async () => ({ ok: true as const }))}
      closeTable={vi.fn(async () => ({ ok: true as const }))}
      releaseSeats={vi.fn(async () => ({ ok: true as const }))}
      reissueDealerOtp={reissue}
    />,
  );
  return { reissue };
}

describe('ConsoleClient — 딜러 OTP', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('재발급하면 화면에 뜬다', async () => {
    renderConsole();

    expect(screen.getByTestId('dealer-otp')).toHaveTextContent('••••••');
    await userEvent.click(screen.getByRole('button', { name: '재발급' }));

    expect(screen.getByTestId('dealer-otp')).toHaveTextContent('920576');
  });

  /**
   * 서버는 해시만 갖고 있어서 **다시 물어볼 수 없다**(`dealerOtpHash`).
   * 그런데 이 화면은 좌석을 해제할 때마다 `router.refresh()`로 다시 그려지고,
   * 사람이 새로 고치기도 한다 — 그때마다 값이 `••••••`로 돌아가면 상점은
   * 아직 쓰지도 않은 번호를 또 재발급해야 하고, 그러면 딜러가 받아 적은
   * 번호가 그 순간 무효가 된다.
   *
   * 한 번 화면에 띄운 값이므로 **그 탭 안에서는** 들고 있는 편이 맞다.
   * 탭을 닫으면 사라지는 것(`sessionStorage`)이 "화면을 벗어나면 재발급"이라는
   * 원래 계약과도 맞는다.
   */
  it('다시 그려도 같은 탭에서는 그 번호가 남는다', async () => {
    const { reissue } = renderConsole();
    await userEvent.click(screen.getByRole('button', { name: '재발급' }));

    // 서버 액션을 다시 부르지 않고, 새로 그린 화면이 스스로 복원한다.
    screen.getByTestId('dealer-otp'); // 첫 인스턴스는 여기서 버린다
    renderConsole(reissue);

    const shown = screen.getAllByTestId('dealer-otp');
    expect(shown[shown.length - 1]).toHaveTextContent('920576');
    expect(reissue).toHaveBeenCalledTimes(1);
  });
});
