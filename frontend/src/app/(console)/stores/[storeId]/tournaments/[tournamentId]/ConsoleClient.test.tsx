import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConsoleClient, { type SeatOccupant, type TournamentMeta } from './ConsoleClient';

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

/**
 * 선택은 **체크한 순간의 사람**을 들고 있어야 한다.
 *
 * 이 화면은 조작마다 `router.refresh()`로 서버 컴포넌트를 다시 돌린다
 * (`ConsoleClient`의 `run`). 그 사이 체크해 둔 자리에서 사람이 탈락하고
 * 다른 사람이 참가 OTP로 앉을 수 있다 — T28이 핸드 도중 착석을 허용해서
 * 창이 항상 열려 있다. 선택이 좌석 번호만 들고 있으면 새로 그린 판에서
 * `userId`를 다시 뽑게 되고, `ReleaseSeatItem`이 `userId`를 요구하는 이유
 * (낡은 화면을 서버가 409로 거절하는 것)가 통째로 무력해진다.
 */
describe('ConsoleClient — 좌석 선택', () => {
  const SEAT_A: SeatOccupant = { seatIndex: 3, userId: 'u1', nickname: 'A' };
  const SEAT_B: SeatOccupant = { seatIndex: 3, userId: 'u2', nickname: 'B' };

  function renderSeats(
    players: SeatOccupant[],
    overrides: {
      releaseSeats?: (
        tournamentId: string,
        tableId: string,
        seats: { seatIndex: number; userId: string }[],
      ) => Promise<{ ok: true } | { error: string }>;
      openTable?: (tournamentId: string) => Promise<{ ok: true } | { error: string }>;
    } = {},
  ) {
    const releaseSeats = vi.fn(overrides.releaseSeats ?? (async () => ({ ok: true as const })));
    const openTable = vi.fn(overrides.openTable ?? (async () => ({ ok: true as const })));
    const view = (seats: SeatOccupant[]) => (
      <ConsoleClient
        storeId="store-1"
        tournamentId="trn-1"
        tournament={TOURNAMENT}
        dashboard={null}
        tables={[{ id: 'tbl-1', tableOrder: 1 }]}
        seatOccupants={[{ tableId: 'tbl-1', tableOrder: 1, players: seats }]}
        seatError={null}
        startTournament={vi.fn(async () => ({ ok: true as const }))}
        openTable={openTable}
        closeTable={vi.fn(async () => ({ ok: true as const }))}
        releaseSeats={releaseSeats}
        reissueDealerOtp={vi.fn(async () => ({ ok: true as const, dealerOtp: '920576' }))}
      />
    );
    const { rerender } = render(view(players));
    return { releaseSeats, openTable, redraw: (next: SeatOccupant[]) => rerender(view(next)) };
  }

  it('판이 새로 그려져 주인이 바뀌어도 체크한 사람의 userId를 보낸다', async () => {
    const { releaseSeats, redraw } = renderSeats([SEAT_A]);

    await userEvent.click(screen.getByTestId('console-seat-3'));
    redraw([SEAT_B]); // A가 탈락하고 B가 같은 자리에 앉았다.

    // 고른 목록은 여전히 체크한 사람을 말한다.
    expect(screen.getByText('4번 · A')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '고른 자리 해제' }));

    // 서버가 409로 거절하는 것이 설계된 동작이다(`releaseSeats`의 검사 1·2).
    // 화면이 id를 판과 함께 갱신해 버리면 그 가드가 항상 통과하고 B가 떨어진다.
    expect(releaseSeats).toHaveBeenCalledWith('trn-1', 'tbl-1', [{ seatIndex: 3, userId: 'u1' }]);
  });

  /**
   * 선택이 판을 따라가지 않게 되면 **빈 자리에 체크가 남는다.** 빈 자리
   * 버튼은 뗄 사람이 없어 눌리지 않으므로, 그 상태로 잠가 두면 상점은
   * 화면을 통째로 새로 고치기 전에는 그 체크를 풀 수 없다.
   */
  it('사람이 사라진 자리도 체크가 남고, 그 체크를 풀 수 있다', async () => {
    const { redraw } = renderSeats([SEAT_A]);

    await userEvent.click(screen.getByTestId('console-seat-3'));
    redraw([]); // 그 사이 자리가 비었다.

    expect(screen.getByText('4번 · A')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('console-seat-3'));
    expect(screen.getByText('해제할 자리를 누르세요.')).toBeInTheDocument();
  });

  /**
   * 서버 액션이 던지는 것은 실패 응답과 다른 길이다 — 프록시가 끊기거나
   * 네트워크가 튀면 `fetch`가 거부되고 `run`의 `await`가 그대로 던진다.
   * `try`가 없으면 처리되지 않은 프라미스 거부만 남고 **화면에는 아무
   * 안내도 뜨지 않는다.**
   */
  it('조작이 던져도 안내가 뜬다', async () => {
    renderSeats([], {
      openTable: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await userEvent.click(screen.getByRole('button', { name: '테이블 추가' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  });
});
