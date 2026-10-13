import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rankWinners } from './showdown.js';

/**
 * 봇 딜러의 승자 입력.
 *
 * 승자를 한 명만 넣던 동안, 그 한 명이 숏스택 올인이면 위층 사이드팟에 자격이 없어
 * 서버가 「승자가 지명되지 않은 팟이 있습니다」로 거절했다(`TableEngine.resolveWinner`).
 * 봇은 그 거절을 못 듣고, 쇼다운에는 차례도 타이머도 없어 그 테이블이 영영 섰다 —
 * 1,000테이블 실측에서 대조군 444테이블 중 442가 그렇게 서 있었고, 전부 사이드팟이
 * 2층 이상이었다.
 *
 * 서버의 판정을 여기 다시 적는다: 팟마다 **가장 높은 순위 그룹 중 그 팟의 자격자**가
 * 받는다. 자격자가 하나도 지명되지 않은 팟이 있으면 거절이다.
 */
const unclaimed = (groups, pots) =>
  pots.filter((pot) => !groups.some((tier) => tier.some((id) => pot.includes(id)))).length;

const player = (id, hasFolded = false) => ({ id, hasFolded });

describe('rankWinners', () => {
  // 실측에서 선 테이블의 모양 — 아래층은 여섯, 맨 위층은 둘만 자격이 있다.
  const players = [player('fold1', true), player('a'), player('b'), player('c'), null, player('d'), player('e'), player('f')];
  const pots = [['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'e', 'f'], ['b', 'c', 'e'], ['b', 'e']];

  it('어느 순서로 뽑아도 지명되지 않은 팟이 없다', () => {
    for (let i = 0; i < 200; i++) {
      const groups = rankWinners(players, Math.random);
      assert.equal(`지명 안 된 팟 ${unclaimed(groups, pots)}`, '지명 안 된 팟 0');
    }
  });

  /** 반대 입력 — 한 명만 넣던 예전 방식이 이 무대에서 실제로 거절되는지. 검사 자체가 무른지 본다. */
  it('맨 아래층에만 자격이 있는 한 명만 넣으면 위층 셋이 비어 거절이다', () => {
    assert.equal(`지명 안 된 팟 ${unclaimed([['d']], pots)}`, '지명 안 된 팟 3');
  });

  it('폴드한 사람과 빈 자리는 순위에 없고, 살아 있는 사람은 한 번씩만 나온다', () => {
    const flat = rankWinners(players, Math.random).flat().sort();
    assert.deepEqual(flat, ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('한 그룹에 한 명 — 칩이 쏠려야 탈락과 리바인이 돈다', () => {
    assert.equal(rankWinners(players, Math.random).every((tier) => tier.length === 1), true);
  });

  /** 「언제나 자리 순서」 구현이 위를 전부 통과한다 — 난수를 조종해 순서가 바뀌는지 본다. */
  it('난수에 따라 1등이 바뀐다', () => {
    const first = (r) => rankWinners(players, () => r)[0][0];
    assert.notEqual(first(0), first(0.99));
  });

  it('살아 있는 사람이 없으면 빈 배열이다', () => {
    assert.deepEqual(rankWinners([player('x', true), null], Math.random), []);
  });
});
