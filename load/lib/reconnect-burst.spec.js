import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BURST_DEFAULTS, burstWakeMs } from './reconnect-burst.js';

const SPREAD = { seatSpreadMs: 40000, dealerSpreadMs: 10000 };

describe('burstWakeMs', () => {
  it('좌석은 [0, seatSpread)에 흩어진다', () => {
    assert.equal(burstWakeMs('seat', 0, SPREAD), 0);
    assert.equal(burstWakeMs('seat', 0.5, SPREAD), 20000);
    assert.equal(burstWakeMs('seat', 0.999999, SPREAD), 39999);
  });

  it('딜러는 좌석 폭이 끝난 뒤 [seatSpread, seatSpread+dealerSpread)에 흩어진다', () => {
    assert.equal(burstWakeMs('dealer', 0, SPREAD), 40000);
    assert.equal(burstWakeMs('dealer', 0.5, SPREAD), 45000);
    assert.equal(burstWakeMs('dealer', 0.999999, SPREAD), 49999);
  });

  it('두 폭이 0이면 전원이 같은 순간이다 — 대조군', () => {
    const zero = { seatSpreadMs: 0, dealerSpreadMs: 0 };
    assert.equal(burstWakeMs('seat', 0.7, zero), 0);
    assert.equal(burstWakeMs('dealer', 0.7, zero), 0);
  });

  it('좌석 폭만 0이면 딜러는 바로, 딜러 폭만 0이면 딜러는 좌석 폭 직후다', () => {
    assert.equal(burstWakeMs('dealer', 0.9, { seatSpreadMs: 0, dealerSpreadMs: 10000 }), 9000);
    assert.equal(burstWakeMs('dealer', 0.9, { seatSpreadMs: 40000, dealerSpreadMs: 0 }), 40000);
  });

  it('기본값은 제품 상수(reconnect-policy.ts)와 같다', () => {
    assert.deepEqual(BURST_DEFAULTS, SPREAD);
    assert.equal(burstWakeMs('seat', 0.5, BURST_DEFAULTS), 20000);
  });
});
