/**
 * 봇 딜러가 쇼다운에 넣는 승자 순위. 순수 함수만 둔다(`windows.js` · `door.js`가 선례다).
 *
 * **살아 있는 전원을 무작위 순위로 넣는다.** 사람 딜러가 숏스택이 이겼을 때 나머지의
 * 승부까지 찍는 것과 같다 — 서버는 팟마다 가장 높은 순위의 자격자에게 주고, 자격자가
 * 하나도 지명되지 않은 팟이 있으면 거절한다(`TableEngine.resolveWinner`).
 *
 * 예전에는 무작위 **한 명**만 넣었다. 그 한 명이 숏스택 올인이면 위층 사이드팟에 자격이
 * 없어 거절됐고, 봇은 그 거절을 못 들었다. 쇼다운에는 차례도 타이머도 없어 그 테이블이
 * 영영 섰다 — 스택이 갈릴수록 층이 생기므로 실행이 길어질수록 선 테이블이 늘었고,
 * 1,000테이블 실측에서 대조군 444테이블 중 442가 쇼다운에 서 있었다.
 *
 * 한 그룹에 한 명씩이라 칩은 여전히 쏠린다 — 탈락 · 리바인 갈래가 그대로 돈다.
 *
 * @param players 스냅샷의 `players`(빈 자리는 null)
 * @param random 0 이상 1 미만
 * @returns 동점 없는 순위. `[['a'], ['b'], ...]`
 */
export function rankWinners(players, random) {
  const alive = players.filter((p) => p && !p.hasFolded).map((p) => p.id);
  // 피셔-예이츠.
  for (let i = alive.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [alive[i], alive[j]] = [alive[j], alive[i]];
  }
  return alive.map((id) => [id]);
}
