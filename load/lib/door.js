/**
 * 로그인 문 판정.
 *
 * 시나리오가 아니라 **판정**이 여기 산다. 순수 함수만 둔다 — I/O도 k6 전역도
 * 쓰지 않는다(`windows.js`가 그 선례다).
 *
 * ## 무엇을 재는가
 *
 * `backend/src/auth/throttle.ts`의 인증 라우트 상한(`AUTH_LIMIT`, IP당 분당
 * 120)이 실제로 몇 번째 요청에서 닫히는가. 응답 하나를 통과 · 상한(429) ·
 * 그 밖의 실패로 가르는 것이 이 모듈의 일이고, 그 분류 위에 "첫 상한이
 * 몇 번째였나"와 "이 구간이 깨끗했나"를 얹는다.
 *
 * ## 429가 아닌 실패를 상한으로 세지 않는다
 *
 * 비밀번호가 틀린 401, 서버 오류의 5xx, 연결 자체가 끊긴 0(k6가 응답을 못
 * 받으면 `status`가 0이다) — 이것들을 상한으로 세면 "문이 몇 개에서
 * 닫히나"라는 질문에 측정이 거짓으로 답하게 된다. 그래서 상태 코드로만
 * 가른다. `ThrottlerGuard`가 던지는 것은 항상 429이고
 * (`auth.throttle.spec.ts`가 그것을 실제 컨트롤러로 확인한다), 그 코드가
 * 유일한 신호다.
 */

/**
 * 응답 하나를 분류한다.
 *
 * @param {{status: number}} response
 * @returns {'pass'|'limited'|'other'}
 */
export function classify(response) {
  const { status } = response;
  if (status >= 200 && status < 300) return 'pass';
  if (status === 429) return 'limited';
  return 'other';
}

/**
 * 응답 열에서 첫 상한이 몇 번째였는지를 낸다. 1부터 센다 — "3번째부터
 * 막혔다"처럼 사람이 그대로 읽을 수 있어야 한다.
 *
 * @param {{status: number}[]} responses
 * @returns {number|null} 상한이 없으면 null
 */
export function firstLimitIndex(responses) {
  const idx = responses.findIndex((r) => classify(r) === 'limited');
  return idx === -1 ? null : idx + 1;
}

/**
 * 이 구간이 깨끗한가 — 상한이 하나도 없었나. 「몇 % 미만이면 통과」 같은
 * 여지를 두지 않는다. 문이 닫혔는지 아닌지는 이진이다.
 *
 * **통과가 하나도 없는 열은 깨끗함이 아니다.** 429가 없다고만 보면, 서버가
 * 죽어 전부 다른 이유(5xx 등)로 실패한 구간도 "상한이 없었으니 깨끗함"이
 * 되어 버린다. 그 구간은 문이 열려 있었는지 자체를 증명하지 못했으므로
 * "깨끗했다"가 아니라 "못 쟀다"다 — 도착률 계단에서 이것을 깨끗함으로 세면
 * 서버가 죽은 구간을 문제없음으로 잘못 읽는다.
 *
 * @param {{status: number}[]} responses
 */
export function isClean(responses) {
  const hasLimit = responses.some((r) => classify(r) === 'limited');
  const hasPass = responses.some((r) => classify(r) === 'pass');
  return hasPass && !hasLimit;
}
