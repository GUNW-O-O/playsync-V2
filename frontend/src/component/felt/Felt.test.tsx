import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import Felt from './Felt';

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
