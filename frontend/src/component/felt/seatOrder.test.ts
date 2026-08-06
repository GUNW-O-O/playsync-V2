import { describe, it, expect } from 'vitest';
import { seatOrder } from './seatOrder';

describe('seatOrder', () => {
  it('좌석 아홉을 하나도 빠뜨리지 않는다', () => {
    for (const o of ['player', 'dealer'] as const) {
      expect([...seatOrder(o)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('두 방향은 서로의 역순이다 — 같은 테이블을 180도 돌린 것이다', () => {
    expect(seatOrder('dealer')).toEqual([...seatOrder('player')].reverse());
  });

  it('좌석 번호 자체는 방향에 따라 바뀌지 않는다', () => {
    // 4번 자리는 어느 화면에서도 4번이다. 고개를 들면 진짜 테이블이 있다.
    expect(seatOrder('player')).toContain(4);
    expect(seatOrder('dealer')).toContain(4);
  });
});
