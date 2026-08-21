import { calculatePrizes, parsePayouts, splitBustedRanks } from './prize';

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

/**
 * 한 핸드에 여러 명이 파산했을 때의 등수와 상금 (T59).
 *
 * 예전에는 `eliminatePlayer`가 등수와 금액을 루프 **밖에서** 한 번 계산해
 * 전원에게 같은 값을 매겼다. 사이드팟이 갈리는 표준 핸드(숏스택 둘이 올인)면
 * 흔한 배치인데, 그러면 3위 상금이 두 번 나가고 2위는 아무도 못 받는다 —
 * `걷은 참가비 == 나간 상금`이 영영 맞지 않아 **대회를 닫을 수 없다.**
 *
 * 트랜잭션도 Redis도 필요 없는 순수 계산이라 여기서 규칙 자체를 덮는다.
 * 동점 경로는 도달 가능성이 낮아 무대를 억지로 만들지 않기로 했고(설계 문서의
 * 「동점은 공동 등수이고, 억지로 재현하지 않는다」), 그 결정이 이 단위 테스트를
 * 규칙의 유일한 증인으로 만든다.
 */
describe('동시 파산의 등수와 상금', () => {
  const STANDARD = [
    { place: 1, percent: 50 },
    { place: 2, percent: 30 },
    { place: 3, percent: 20 },
  ];
  /** 풀 40000 · 50/30/20 → 1위 20000 · 2위 12000 · 3위 8000. */
  const POOL = 40000;

  it('핸드 시작 스택이 크면 높은 등수를 받는다', () => {
    // 결함의 재현 값 그대로다. 예전에는 둘 다 `3위 8000원`이었다.
    // 배열 순서가 아니라 스택이 정한다는 것을 보이려고 작은 쪽을 먼저 넣는다.
    const awards = splitBustedRanks(
      [
        { userId: 'dave', seatIndex: 3, handStartStack: 1000 },
        { userId: 'carol', seatIndex: 2, handStartStack: 3000 },
      ],
      3, POOL, STANDARD,
    );

    expect(awards).toEqual([
      { userId: 'carol', place: 2, amount: 12000 },
      { userId: 'dave', place: 3, amount: 8000 },
    ]);
  });

  it('한 명이면 그 배치의 마지막 등수를 그대로 받는다', () => {
    // 지금까지의 유일한 경로다. 새 계산이 옛 결과를 바꾸지 않아야 한다.
    expect(splitBustedRanks(
      [{ userId: 'carol', seatIndex: 2, handStartStack: 0 }],
      3, POOL, STANDARD,
    )).toEqual([{ userId: 'carol', place: 3, amount: 8000 }]);
  });

  it('스택이 같으면 공동 등수이고 두 등수의 상금을 합쳐 나눈다', () => {
    // 둘 다 startStack 전액을 올인한 경우. 포커 표준대로 공동 등수(위쪽)를
    // 주고 2위 12000 + 3위 8000 = 20000을 반씩 나눈다.
    const awards = splitBustedRanks(
      [
        { userId: 'carol', seatIndex: 2, handStartStack: 3000 },
        { userId: 'dave', seatIndex: 3, handStartStack: 3000 },
      ],
      3, POOL, STANDARD,
    );

    expect(awards).toEqual([
      { userId: 'carol', place: 2, amount: 10000 },
      { userId: 'dave', place: 2, amount: 10000 },
    ]);
  });

  it('나머지 한 단위는 좌석 인덱스가 작은 쪽이 흡수한다', () => {
    // 풀 107 · 50/30/20 → 1위 54 · 2위 32 · 3위 21. 공동 등수의 몫은 53이라
    // 반으로 나누면 26.5다. 각자 내림하면 1원이 어디에도 속하지 않고
    // 사라진다 — 사이드팟 증발(T15)과 같은 모양이고, 합계가 풀과 어긋나면
    // `completeSession`이 영영 안 열린다.
    const awards = splitBustedRanks(
      [
        { userId: 'far', seatIndex: 4, handStartStack: 500 },
        { userId: 'near', seatIndex: 1, handStartStack: 500 },
      ],
      3, 107, STANDARD,
    );

    expect(awards).toEqual([
      { userId: 'near', place: 2, amount: 27 },
      { userId: 'far', place: 2, amount: 26 },
    ]);
  });

  it('상금권 밖이면 전원 0원이다', () => {
    // 등록이 열려 있는 동안의 탈락이 여기다. 등수는 기록으로 남기고 돈은
    // 움직이지 않는다 — `prizeFor`가 이미 하는 일이지만, 그룹으로 나누는
    // 계산이 그것을 깨지 않는지가 검증 대상이다.
    const awards = splitBustedRanks(
      [
        { userId: 'e', seatIndex: 0, handStartStack: 900 },
        { userId: 'f', seatIndex: 1, handStartStack: 100 },
      ],
      5, POOL, STANDARD,
    );

    expect(awards).toEqual([
      { userId: 'e', place: 4, amount: 0 },
      { userId: 'f', place: 5, amount: 0 },
    ]);
  });

  it('배치가 가져간 등수들의 상금 합계가 그대로 나간다', () => {
    // 등수를 스칼라가 아니라 **구간**으로 다루는 것이 이 티켓의 요점이다.
    // 구간의 합이 보존되지 않으면 한 배치 안에서 돈이 늘거나 준다.
    const range = calculatePrizes(POOL, STANDARD);

    for (const stacks of [[3000, 1000], [3000, 3000], [5000, 3000, 1000], [7000, 7000, 7000]]) {
      const busted = stacks.map((handStartStack, i) => ({
        userId: `p${i}`, seatIndex: i, handStartStack,
      }));
      const lastPlace = 1 + stacks.length; // 2 … n+1. 1위는 우승자 몫이라 뺀다
      const paid = splitBustedRanks(busted, lastPlace, POOL, STANDARD)
        .reduce((sum, a) => sum + a.amount, 0);

      let expected = 0;
      for (let place = lastPlace - stacks.length + 1; place <= lastPlace; place++) {
        expected += range.get(place) ?? 0;
      }
      expect(`${stacks}: 지급 ${paid}`).toBe(`${stacks}: 지급 ${expected}`);
    }
  });
});
