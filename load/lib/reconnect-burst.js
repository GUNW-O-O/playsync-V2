/**
 * 재접속 폭발에서 소켓이 언제 다시 열리고, 테이블이 언제 다 돌아왔나.
 *
 * 순수 함수다 — k6 전역도 시계도 모른다(`windows.js`가 선례). 테스트는
 * `reconnect-burst.spec.js`.
 *
 * **제품의 재접속 정책을 따른다.** k6는 프론트를 import할 수 없어 숫자를
 * 복사했다. 원본은 `frontend/src/lib/reconnect-policy.ts`의 `reconnectDelayMs`와
 * `SEAT_SPREAD_MS`(40,000) · `DEALER_SPREAD_MS`(10,000) · `MAX_ATTEMPTS`(8)이고,
 * 딜러는 `DEALER_OFFSET_MS`(= `SEAT_SPREAD_MS`)만큼 늦게 시작한다 — 딜러가
 * 정착한 테이블을 보게 하려는 것이다. 원본이 바뀌면 여기도 바꾼다. 어긋나도
 * 잡아 주는 장치는 없다.
 */
export const BURST_DEFAULTS = { seatSpreadMs: 40000, dealerSpreadMs: 10000 };

/** 몇 번까지 다시 붙나. 넘으면 제품은 사람에게 새로고침을 맡긴다. */
export const MAX_ATTEMPTS = 8;

/**
 * 다음 시도까지 기다릴 ms. **더 시도하지 않을 때는 `null`.**
 *
 * 폭발의 첫 깨어남(`attempt` 0)과 티켓 · 소켓 실패 뒤의 재시도가 같은 함수다 —
 * 제품 단말(`useTableSocket`)이 한 카운터로 둘을 센다(T113). 재시도가 따로
 * T93 공식(소켓 1만이면 16.7분 폭)을 쓰던 동안 서버 무응답 14건이 5분 초과 2 ·
 * 미복구 6이 됐다.
 *
 * @param {number} attempt 0부터. 이미 몇 번 기다렸나
 * @param {'seat'|'dealer'} role
 * @param {number} rand [0, 1) 난수. 주입하므로 가장자리 값을 테스트가 넣는다.
 * @param {{seatSpreadMs: number, dealerSpreadMs: number}} [spread] 두 폭이 0이면
 *   전원이 같은 순간이다(대조군).
 * @returns {number|null}
 */
export function reconnectDelayMs(attempt, role, rand, { seatSpreadMs, dealerSpreadMs } = BURST_DEFAULTS) {
  if (attempt >= MAX_ATTEMPTS) return null;
  const spread = role === 'dealer' ? dealerSpreadMs : seatSpreadMs;
  const offset = role === 'dealer' ? seatSpreadMs : 0;
  // 폭만 늘리고 오프셋은 안 늘린다 — 제품과 같다.
  return offset + Math.floor(rand * spread) * 2 ** Math.min(attempt, 3);
}

/**
 * 폭발 하나의 복구 판정. 테이블의 모든 자리가 첫 `renderGame`을 다시 받은
 * 순간이 복구 완료다.
 *
 * **소켓이 아니라 자리로 센다**(T113). 비정상 종료한 소켓을 다시 열면 같은
 * 자리에 새 소켓이 생기는데, 소켓 번호로 세면 그 자리가 두 번 세어져 아직
 * 안 온 자리가 있는데 끝난다.
 *
 * @param {number} seatCount 좌석 수. 딜러는 따로 하나다(자리 -1)
 */
export function createBurst(seatCount) {
  const seen = new Set();
  let seats = 0;
  return {
    /**
     * @param {number} seat 좌석 번호. 딜러는 -1
     * @returns {{dealer: boolean, seatsDone: boolean, allDone: boolean}|null}
     *   이미 본 자리면 null
     */
    see(seat) {
      if (seen.has(seat)) return null;
      seen.add(seat);
      const dealer = seat < 0;
      const seatsDone = !dealer && ++seats >= seatCount;
      return { dealer, seatsDone, allDone: seen.size >= seatCount + 1 };
    },
  };
}
