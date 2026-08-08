import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GamePhase, type TableState } from '@/app/types/game';
import Felt from './Felt';

function tablePlayer(seatIndex: number, nickname: string) {
  return {
    id: `u-${seatIndex}`,
    tableId: 'tbl-1',
    nickname,
    seatIndex,
    stack: 5000,
    bet: 0,
    hasFolded: false,
    isAllIn: false,
    // 백엔드는 이 값을 채우지 않는다. 스냅샷이 들고 있는 것은 `buttonUser`
    // 하나뿐이라, 화면이 이 필드를 믿으면 버튼이 영영 안 그려진다.
    button: false,
    totalContributed: 0,
  };
}

function stateWithButton(buttonUser: number): TableState {
  const players = Array.from({ length: 9 }, () => null) as TableState['players'];
  players[0] = tablePlayer(0, '숏스택');
  players[4] = tablePlayer(4, '딥스택');
  return {
    phase: GamePhase.PRE_FLOP,
    players,
    buttonUser,
    currentTurnSeatIndex: 0,
    pot: 300,
    sidePots: [],
    currentBet: 200,
    smallBlind: 100,
    ante: false,
    tournamentId: 'trn-1',
  };
}

/** 퍼센트 문자열("73.6%")을 숫자로 판다. */
function pct(value: string): number {
  return parseFloat(value.replace('%', ''));
}

describe('Felt — 딜러 180° 회전', () => {
  /**
   * `seatPosition`(Felt.tsx 하단)이 `dealer`일 때만 각도에 180°를 더한다.
   * `seatOrder`(seatOrder.test.ts가 이미 지킨다)는 DOM 순서만 바꿀 뿐 좌표는
   * 그대로다 — 그래서 좌표 자체를 지키는 테스트가 따로 필요하다. 이게 없으면
   * `+ 180`을 지워도(=딜러가 참가자와 같은 화면을 보게 돼도) 어느 테스트도
   * 빨개지지 않는다.
   *
   * 같은 테이블을 반대편에서 보는 것이므로 참가자 화면의 (x, y)는 딜러
   * 화면에서 정확히 (100-x, 100-y)여야 한다(Felt.tsx 132–141행 주석).
   */
  it('같은 좌석의 좌표가 참가자·딜러 화면에서 (100-x, 100-y) 관계다', () => {
    const player = render(<Felt state={null} orientation="player" mySeatIndex={null} />);
    const dealer = render(<Felt state={null} orientation="dealer" mySeatIndex={null} />);

    for (let seatIndex = 0; seatIndex < 9; seatIndex++) {
      const playerSeat = within(player.container).getByTestId(`seat-${seatIndex}`);
      const dealerSeat = within(dealer.container).getByTestId(`seat-${seatIndex}`);

      const playerLeft = pct(playerSeat.style.left);
      const playerTop = pct(playerSeat.style.top);
      const dealerLeft = pct(dealerSeat.style.left);
      const dealerTop = pct(dealerSeat.style.top);

      expect(dealerLeft).toBeCloseTo(100 - playerLeft, 5);
      expect(dealerTop).toBeCloseTo(100 - playerTop, 5);
    }
  });
});

describe('Felt — 딜러와 버튼의 자리', () => {
  /**
   * 사람 딜러가 어디 서 있는지가 이 화면의 방향 자체다. 좌석 배치는 딜러를
   * 12시로 놓고 도는데(`seatPosition`), 정작 그 12시에 아무 표시가 없어서
   * 화면만 보고는 어느 쪽이 딜러인지 알 수 없었다.
   */
  it('딜러 표찰이 있다', () => {
    render(<Felt state={null} orientation="player" mySeatIndex={null} />);
    expect(screen.getByTestId('felt-dealer-mark')).toBeInTheDocument();
  });

  /**
   * **버튼은 `buttonUser`에서 나온다.** 스냅샷의 `player.button`은 백엔드가
   * 채우지 않는 필드라(엔진은 `state.buttonUser`만 옮긴다) 그것을 믿으면
   * 버튼이 어느 자리에도 안 붙는다 — 실제로 촬영본에 한 번도 안 나왔다.
   */
  it('버튼이 buttonUser가 가리키는 자리에 붙는다', () => {
    render(<Felt state={stateWithButton(4)} orientation="player" mySeatIndex={null} />);

    expect(screen.getByTestId('seat-4-button')).toBeInTheDocument();
    expect(screen.queryByTestId('seat-0-button')).toBeNull();
  });

  it('버튼이 옮겨 가면 표시도 옮겨 간다', () => {
    // 한 자리만 보면 "항상 4번에 붙는다"도 통과한다.
    render(<Felt state={stateWithButton(0)} orientation="dealer" mySeatIndex={null} />);

    expect(screen.getByTestId('seat-0-button')).toBeInTheDocument();
    expect(screen.queryByTestId('seat-4-button')).toBeNull();
  });
});
