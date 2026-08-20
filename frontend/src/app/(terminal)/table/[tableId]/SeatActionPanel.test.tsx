import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GamePhase, type TableState } from '@/app/types/game';
import SeatActionPanel from './SeatActionPanel';

function tablePlayer(overrides: Partial<NonNullable<TableState['players'][number]>> = {}) {
  return {
    id: 'u-1',
    tableId: 'tbl-1',
    nickname: '박하윤',
    seatIndex: 0,
    stack: 5000,
    bet: 0,
    hasFolded: false,
    isAllIn: false,
    button: false,
    totalContributed: 0,
    ...overrides,
  };
}

function baseState(overrides: Partial<TableState> = {}): TableState {
  return {
    phase: GamePhase.PRE_FLOP,
    players: [tablePlayer(), tablePlayer({ id: 'u-2', seatIndex: 1 }), null, null, null, null, null, null, null],
    buttonUser: 0,
    currentTurnSeatIndex: 0,
    pot: 300,
    sidePots: [],
    currentBet: 200,
    smallBlind: 100,
    ante: 0,
    tournamentId: 'trn-1',
    ...overrides,
  };
}

/** 세 자리는 상태와 무관하게 늘 있어야 한다. */
const SLOTS = ['action-slider-slot', 'action-buttons-slot', 'action-timer-slot'];

describe('SeatActionPanel', () => {
  /**
   * 좌석 태블릿은 **팔 길이에서 보는 고정 기기**다. 차례가 올 때마다
   * 슬라이더와 타이머가 생겼다 사라지면 버튼이 위아래로 움직이고, 그러면
   * 방금까지 `폴드`가 있던 자리를 눌러 `올인`이 나간다.
   *
   * 그래서 자리는 늘 잡아 두고 **내용만 바뀐다.**
   */
  it('내 차례가 아닐 때도 슬라이더·버튼·타이머 자리가 그대로 있다', () => {
    render(
      <SeatActionPanel
        state={baseState({ currentTurnSeatIndex: 1 })}
        mySeatIndex={0}
        onAction={vi.fn()}
      />,
    );

    for (const slot of SLOTS) expect(screen.getByTestId(slot)).toBeInTheDocument();
    // 자리만 잡는 것이지 누를 수 있는 것이 아니다.
    expect(screen.queryByRole('button', { name: '폴드' })).toBeNull();
  });

  it('내 차례여도 같은 세 자리다', () => {
    render(
      <SeatActionPanel
        state={baseState({ actionDeadline: Date.now() + 15_000 })}
        mySeatIndex={0}
        onAction={vi.fn()}
      />,
    );

    for (const slot of SLOTS) expect(screen.getByTestId(slot)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '폴드' })).toBeInTheDocument();
  });

  it('대기 중에도, 쇼다운에도 같은 세 자리다', () => {
    // 페이즈로 일찍 반환하던 가지들이다. 여기서 자리가 사라지면 핸드가
    // 끝날 때마다 화면 아래쪽이 통째로 접힌다.
    for (const phase of [GamePhase.WAITING, GamePhase.SHOWDOWN]) {
      const { unmount } = render(
        <SeatActionPanel
          state={baseState({ phase, currentTurnSeatIndex: -1 })}
          mySeatIndex={0}
          onAction={vi.fn()}
        />,
      );
      for (const slot of SLOTS) expect(screen.getByTestId(slot)).toBeInTheDocument();
      unmount();
    }
  });

  it('스냅샷이 아직 없어도 같은 세 자리다', () => {
    render(<SeatActionPanel state={null} mySeatIndex={0} onAction={vi.fn()} />);

    for (const slot of SLOTS) expect(screen.getByTestId(slot)).toBeInTheDocument();
  });
});
