/**
 * 재접속 폭발에서 소켓이 깨어날 시각.
 *
 * 순수 함수다 — k6 전역도 시계도 모른다(`windows.js`가 선례). 테스트는
 * `reconnect-burst.spec.js`.
 *
 * **제품의 재접속 정책을 따른다.** k6는 프론트를 import할 수 없어 숫자를
 * 복사했다. 원본은 `frontend/src/lib/reconnect-policy.ts`의 `SEAT_SPREAD_MS`
 * (40,000)와 `DEALER_SPREAD_MS`(10,000)이고, 딜러는 `DEALER_OFFSET_MS`
 * (= `SEAT_SPREAD_MS`)만큼 늦게 시작한다 — 딜러가 정착한 테이블을 보게 하려는
 * 것이다. 원본이 바뀌면 여기도 바꾼다. 어긋나도 잡아 주는 장치는 없다.
 */
export const BURST_DEFAULTS = { seatSpreadMs: 40000, dealerSpreadMs: 10000 };

/**
 * @param {'seat'|'dealer'} role
 * @param {number} rand [0, 1) 난수. 주입하므로 가장자리 값을 테스트가 넣는다.
 * @returns 폭발 시작부터 깨어날 때까지의 ms. 좌석은 [0, seat), 딜러는
 *   [seat, seat + dealer). 두 폭이 0이면 전원이 같은 순간이다(대조군).
 */
export function burstWakeMs(role, rand, { seatSpreadMs, dealerSpreadMs }) {
  return role === 'dealer'
    ? seatSpreadMs + Math.floor(rand * dealerSpreadMs)
    : Math.floor(rand * seatSpreadMs);
}
