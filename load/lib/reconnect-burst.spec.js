import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BURST_DEFAULTS, MAX_ATTEMPTS, createBurst, reconnectDelayMs } from './reconnect-burst.js';

const SPREAD = { seatSpreadMs: 40000, dealerSpreadMs: 10000 };

describe('reconnectDelayMs', () => {
  it('좌석은 [0, seatSpread)에 흩어진다', () => {
    assert.equal(reconnectDelayMs(0, 'seat', 0, SPREAD), 0);
    assert.equal(reconnectDelayMs(0, 'seat', 0.5, SPREAD), 20000);
    assert.equal(reconnectDelayMs(0, 'seat', 0.999999, SPREAD), 39999);
  });

  it('딜러는 좌석 폭이 끝난 뒤 [seatSpread, seatSpread+dealerSpread)에 흩어진다', () => {
    assert.equal(reconnectDelayMs(0, 'dealer', 0, SPREAD), 40000);
    assert.equal(reconnectDelayMs(0, 'dealer', 0.5, SPREAD), 45000);
    assert.equal(reconnectDelayMs(0, 'dealer', 0.999999, SPREAD), 49999);
  });

  it('두 폭이 0이면 전원이 같은 순간이다 — 대조군', () => {
    const zero = { seatSpreadMs: 0, dealerSpreadMs: 0 };
    assert.equal(reconnectDelayMs(0, 'seat', 0.7, zero), 0);
    assert.equal(reconnectDelayMs(0, 'dealer', 0.7, zero), 0);
  });

  it('좌석 폭만 0이면 딜러는 바로, 딜러 폭만 0이면 딜러는 좌석 폭 직후다', () => {
    assert.equal(reconnectDelayMs(0, 'dealer', 0.9, { seatSpreadMs: 0, dealerSpreadMs: 10000 }), 9000);
    assert.equal(reconnectDelayMs(0, 'dealer', 0.9, { seatSpreadMs: 40000, dealerSpreadMs: 0 }), 40000);
  });

  /**
   * **폭만 늘리고 오프셋은 안 늘린다**(T113). 하네스가 T93 공식(16.7분 폭)을
   * 쓰던 동안 서버 무응답 14건이 5분 초과 2 · 미복구 6이 됐다. 제품은 40초에서
   * 두 배씩, 셋째부터 ×8에 멈춘다.
   */
  it('거듭 실패하면 지터 폭이 두 배씩 늘고 ×8에서 멈춘다', () => {
    const seat = (attempt) => reconnectDelayMs(attempt, 'seat', 0.5, SPREAD);
    assert.equal(`${seat(1)} ${seat(2)} ${seat(3)} ${seat(5)}`, '40000 80000 160000 160000');
    // 딜러의 오프셋(40초)은 그대로이고 딜러 폭만 는다.
    assert.equal(reconnectDelayMs(2, 'dealer', 0.5, SPREAD), 40000 + 5000 * 4);
  });

  it('여덟 번을 넘기면 null — 더 시도하지 않는다', () => {
    assert.equal(typeof reconnectDelayMs(MAX_ATTEMPTS - 1, 'seat', 0.5, SPREAD), 'number');
    assert.equal(reconnectDelayMs(MAX_ATTEMPTS, 'seat', 0.5, SPREAD), null);
    assert.equal(reconnectDelayMs(MAX_ATTEMPTS, 'dealer', 0.5, SPREAD), null);
  });

  it('기본값은 제품 상수(reconnect-policy.ts)와 같다', () => {
    assert.deepEqual(BURST_DEFAULTS, SPREAD);
    assert.equal(MAX_ATTEMPTS, 8);
    assert.equal(reconnectDelayMs(0, 'seat', 0.5), 20000);
  });
});

describe('createBurst', () => {
  /** 좌석 0..8 아홉과 딜러(-1). */
  const SEATS = 9;

  it('좌석 아홉과 딜러가 다 보여야 끝난다', () => {
    const burst = createBurst(SEATS);
    for (let seat = 0; seat < SEATS; seat++) {
      const r = burst.see(seat);
      assert.equal(`${seat} ${r.seatsDone} ${r.allDone}`, `${seat} ${seat === SEATS - 1} false`);
    }
    const last = burst.see(-1);
    assert.equal(`${last.dealer} ${last.allDone}`, 'true true');
  });

  it('딜러가 먼저 와도 좌석이 다 와야 끝난다', () => {
    const burst = createBurst(SEATS);
    assert.equal(burst.see(-1).allDone, false);
    for (let seat = 0; seat < SEATS - 1; seat++) burst.see(seat);
    assert.equal(burst.see(SEATS - 1).allDone, true);
  });

  /**
   * **다시 연 소켓은 같은 자리를 한 번만 센다**(T113). 첫 화면을 받은 좌석이
   * 비정상 종료로 다시 열리면 새 소켓이 같은 자리의 첫 화면을 또 받는다 —
   * 소켓 번호로 세면 그 둘이 둘로 세어져 아직 안 온 자리가 있는데 끝난다.
   */
  it('같은 자리가 두 번 와도 한 번이다', () => {
    const burst = createBurst(SEATS);
    burst.see(0);
    assert.equal(burst.see(0), null);
    for (let seat = 1; seat < SEATS - 1; seat++) burst.see(seat);
    // 좌석 8이 아직이다. 0을 두 번 셌으면 여기서 좌석이 끝났다고 한다.
    assert.equal(burst.see(-1).allDone, false);
  });
});
