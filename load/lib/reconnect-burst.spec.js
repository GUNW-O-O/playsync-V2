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
   * **실패한 뒤에는 폭이 아니라 걸음이다**(T119). 제품은 5초에서 두 배씩 가다
   * 40초에 멈추고, 걸음마다 ±50%로 흩는다. 폭(두 배씩 320초까지)이던 동안
   * 667테이블 kill의 `SYNCING` 해제가 407초였다.
   */
  it('거듭 실패하면 5초에서 두 배씩 가다 40초에 멈춘다', () => {
    const seat = (attempt) => reconnectDelayMs(attempt, 'seat', 0.5, SPREAD);
    assert.equal(`${seat(1)} ${seat(2)} ${seat(3)} ${seat(4)} ${seat(9)}`, '5000 10000 20000 40000 40000');
    assert.equal(reconnectDelayMs(1, 'seat', 0, SPREAD), 2500);
    // 딜러의 오프셋은 첫 시도뿐이다.
    assert.equal(reconnectDelayMs(2, 'dealer', 0.5, SPREAD), 10000);
    // 걸음은 폭 설정과 무관하다 — 대조군(폭 0)에서도 재시도는 같은 걸음이다.
    assert.equal(reconnectDelayMs(1, 'seat', 0.5, { seatSpreadMs: 0, dealerSpreadMs: 0 }), 5000);
  });

  it('상한을 넘기면 null — 더 시도하지 않는다', () => {
    assert.equal(typeof reconnectDelayMs(MAX_ATTEMPTS - 1, 'seat', 0.5, SPREAD), 'number');
    assert.equal(reconnectDelayMs(MAX_ATTEMPTS, 'seat', 0.5, SPREAD), null);
    assert.equal(reconnectDelayMs(MAX_ATTEMPTS, 'dealer', 0.5, SPREAD), null);
  });

  it('기본값은 제품 상수(reconnect-policy.ts)와 같다', () => {
    assert.deepEqual(BURST_DEFAULTS, SPREAD);
    assert.equal(MAX_ATTEMPTS, 30);
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
