import { calculatePrizes, parsePayouts } from './prize';

/**
 * 상금 분배.
 *
 * 참가비를 걷는 쪽은 이미 맞게 돌고 있었다(`totalBuyinAmount`). 없던 것은
 * **내보내는 쪽**이다 — 우승 상금이 `3000` 상수라 참가비가 얼마든 같았다.
 *
 * 칩과 같은 규칙이 돈에도 적용된다. 걷은 것과 나간 것이 맞아야 한다.
 * 나머지 원이 증발하면 사이드팟 증발(T15)과 같은 종류의 버그다.
 */
describe('상금 분배', () => {
  const STANDARD = [
    { place: 1, percent: 50 },
    { place: 2, percent: 30 },
    { place: 3, percent: 20 },
  ];

  it('비율대로 나눈다', () => {
    const prizes = calculatePrizes(100000, STANDARD);

    expect(prizes.get(1)).toBe(50000);
    expect(prizes.get(2)).toBe(30000);
    expect(prizes.get(3)).toBe(20000);
  });

  it('나눠 떨어지지 않으면 나머지는 1등이 흡수한다', () => {
    // 33333.33...이 세 번. 버리면 1원이 사라진다. 걷은 돈과 나간 돈이
    // 맞지 않는 순간 어디로 갔는지 설명할 방법이 없다.
    const prizes = calculatePrizes(100000, [
      { place: 1, percent: 34 },
      { place: 2, percent: 33 },
      { place: 3, percent: 33 },
    ]);

    const total = [...prizes.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(100000);
  });

  it('어떤 풀이 와도 총액은 풀과 같다', () => {
    for (const pool of [1, 7, 999, 100001, 1234567]) {
      const total = [...calculatePrizes(pool, STANDARD).values()]
        .reduce((s, v) => s + v, 0);
      expect(`풀 ${pool}: 지급 ${total}`).toBe(`풀 ${pool}: 지급 ${pool}`);
    }
  });

  it('풀이 0이면 전원 0이다', () => {
    const prizes = calculatePrizes(0, STANDARD);
    expect([...prizes.values()]).toEqual([0, 0, 0]);
  });

  describe('분배율 검증', () => {
    it('합이 100이 아니면 거부한다', () => {
      // 90이면 10%가 어디로 가는지 아무도 모른다. 대회가 끝난 뒤에
      // 발견되면 이미 돈이 나간 뒤다. 생성 시점에 막는다.
      expect(() => parsePayouts([
        { place: 1, percent: 50 },
        { place: 2, percent: 40 },
      ])).toThrow(/합이 100/);
    });

    it('비어 있으면 거부한다', () => {
      expect(() => parsePayouts([])).toThrow(/한 명 이상/);
    });

    it('순위가 1부터 연속하지 않으면 거부한다', () => {
      // 1등과 3등만 있고 2등이 없는 대회는 없다.
      expect(() => parsePayouts([
        { place: 1, percent: 50 },
        { place: 3, percent: 50 },
      ])).toThrow(/1위부터 연속/);
    });

    it('음수나 0인 비율은 거부한다', () => {
      expect(() => parsePayouts([
        { place: 1, percent: 110 },
        { place: 2, percent: -10 },
      ])).toThrow(/0보다 커야/);
    });

    it('올바른 분배율은 순위 순으로 정렬해서 돌려준다', () => {
      const parsed = parsePayouts([
        { place: 2, percent: 30 },
        { place: 1, percent: 70 },
      ]);
      expect(parsed.map(p => p.place)).toEqual([1, 2]);
    });
  });
});
