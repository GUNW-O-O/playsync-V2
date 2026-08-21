import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlayerActionType } from '@playsync/contract';
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

/** 0번 자리에 나, 1번 자리에 상대. 나머지는 빈 좌석. */
function seats(me: Partial<NonNullable<TableState['players'][number]>>) {
  return [
    tablePlayer(me),
    tablePlayer({ id: 'u-2', seatIndex: 1 }),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
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

  /**
   * `amount`는 총 베팅액이라(`table-engine.ts`의 `handleRaise`가
   * `betAmount - player.bet`을 뺀다) 낼 수 있는 최대 총액은 `stack`이 아니라
   * **`stack + bet`**이다. 차례 초기화만 `stack`으로 자르면, 블라인드를 이미
   * 깔아 둔 사람이 낼 수 있는 최소 레이즈를 못 낸다.
   *
   * `currentBet 200` · `bigBlind 200` · `bet 100` · `stack 300`이면 최소 레이즈
   * 400을 낼 수 있는데(300 + 100), `stack`으로 자르면 300이 되어 버튼은
   * "레이즈 300"이라 적힌 채 비활성이고 슬라이더만 400에 선다.
   */
  it('차례가 오면 stack이 아니라 stack + bet 기준으로 최소 레이즈를 세운다', () => {
    const state = (turn: number) =>
      baseState({
        currentTurnSeatIndex: turn,
        currentBet: 200,
        smallBlind: 100,
        players: seats({ stack: 300, bet: 100 }),
      });

    const { rerender } = render(
      <SeatActionPanel state={state(1)} mySeatIndex={0} onAction={vi.fn()} />,
    );
    rerender(<SeatActionPanel state={state(0)} mySeatIndex={0} onAction={vi.fn()} />);

    expect(screen.getByRole('button', { name: '레이즈 400' })).toBeEnabled();
  });

  /**
   * 초기화가 `turnKey` **변화**에만 걸려 있으면, 내 차례 도중에 새로고침이나
   * 재접속이 걸린 경우 한 번도 돌지 않는다 — 마운트 시점의 `turnKey`가 곧
   * 시드값이라 같기 때문이다. 판정은 "차례가 바뀌었나"가 아니라 **"지금 내
   * 차례인가"**여야 한다.
   */
  it('내 차례 도중에 마운트해도 최소 레이즈로 선다', () => {
    render(<SeatActionPanel state={baseState()} mySeatIndex={0} onAction={vi.fn()} />);

    // currentBet 200 + bigBlind 200 = 400.
    expect(screen.getByRole('button', { name: '레이즈 400' })).toBeEnabled();
  });

  /**
   * 한 페이즈 안에서도 상대의 레이즈를 거쳐 차례가 **다시** 돌아온다. 그때도
   * 새 최소 레이즈로 다시 서야 한다 — 직전에 내가 만져 둔 값이 남으면 그것이
   * 새 `min`보다 작아, 슬라이더를 건드리기 전까지 레이즈가 막힌다(둘째와 같은
   * 증상이다).
   */
  it('같은 페이즈에서 차례가 다시 돌아오면 새 최소 레이즈로 다시 선다', () => {
    const view = (turn: number, currentBet: number) =>
      baseState({ currentTurnSeatIndex: turn, currentBet, smallBlind: 100 });

    const { rerender } = render(
      <SeatActionPanel state={view(0, 200)} mySeatIndex={0} onAction={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '600' } });
    expect(screen.getByRole('button', { name: '레이즈 600' })).toBeEnabled();

    // 상대가 600으로 올리고 차례가 돌아왔다. 페이즈는 그대로다.
    rerender(<SeatActionPanel state={view(1, 600)} mySeatIndex={0} onAction={vi.fn()} />);
    rerender(<SeatActionPanel state={view(0, 600)} mySeatIndex={0} onAction={vi.fn()} />);

    expect(screen.getByRole('button', { name: '레이즈 800' })).toBeEnabled();
  });

  /**
   * 레이즈할 여력이 되는지는 "콜하면 다 들어가나"(`goingToAllIn`)와 다른
   * 질문이다. `currentBet 100` · `bigBlind 20` · `bet 0` · `stack 110`이면
   * 최소 레이즈 총액 120을 낼 수 없는데(최대 110), 콜은 다 들어가지 않아
   * 레이즈 칸이 열린다. 그렇게 열린 슬라이더는 낼 수 없는 120 하나만 고를 수
   * 있고, 그 120을 보내면 엔진이 `Math.min(needed, stack)`으로 깎아 **에러
   * 없이 110 올인**이 된다.
   */
  it('레이즈할 여력이 없으면 슬라이더와 레이즈 버튼을 감춘다', () => {
    const onAction = vi.fn();
    render(
      <SeatActionPanel
        state={baseState({
          currentBet: 100,
          smallBlind: 10,
          players: seats({ stack: 110, bet: 0 }),
        })}
        mySeatIndex={0}
        onAction={onAction}
      />,
    );

    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: /^레이즈/ })).toBeNull();

    // 콜과 올인은 남는다. 낼 수 없는 금액이 아니라 낼 수 있는 전부가 나간다.
    expect(screen.getByRole('button', { name: '콜 100' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '올인' }));
    expect(onAction).toHaveBeenCalledWith({ action: PlayerActionType.RAISE, amount: 110 });
  });

  it('스냅샷이 아직 없어도 같은 세 자리다', () => {
    render(<SeatActionPanel state={null} mySeatIndex={0} onAction={vi.fn()} />);

    for (const slot of SLOTS) expect(screen.getByTestId(slot)).toBeInTheDocument();
  });
});
