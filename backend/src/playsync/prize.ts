/**
 * 프라이즈풀 분배.
 *
 * 참가비를 걷는 쪽(`totalBuyinAmount`)은 이미 돌고 있었다. 내보내는 쪽이
 * 상수였다 — 우승 상금이 참가비와 무관하게 항상 `3000`이었다.
 *
 * 분배율은 **대회 생성 시 상점이 정한다.** 기본값을 두지 않는 이유는, 상금
 * 비율이 코드가 정할 수 있는 성질의 값이 아니기 때문이다. 안 정하면 대회를
 * 만들 수 없는 편이, 모르는 비율로 돈이 나가는 것보다 낫다.
 */

export interface PrizePayout {
  /** 등수. 1부터 연속해야 한다. */
  place: number;
  /** 프라이즈풀에서 가져가는 비율(%). 전체 합이 100이어야 한다. */
  percent: number;
}

/**
 * 분배율을 검증하고 순위 순으로 정렬한다.
 *
 * 생성 시점에 막는 것이 요점이다. 합이 100이 아닌 대회는 상금을 지급하는
 * 순간에야 어긋남이 드러나는데, 그때는 이미 돈이 나간 뒤다.
 */
export function parsePayouts(payouts: PrizePayout[]): PrizePayout[] {
  if (payouts.length === 0) {
    throw new Error('상금을 받는 등수가 한 명 이상 있어야 합니다.');
  }

  for (const { percent } of payouts) {
    if (percent <= 0) {
      throw new Error('상금 비율은 0보다 커야 합니다.');
    }
  }

  const sorted = [...payouts].sort((a, b) => a.place - b.place);
  const contiguous = sorted.every((p, index) => p.place === index + 1);
  if (!contiguous) {
    throw new Error('상금 등수는 1위부터 연속해야 합니다.');
  }

  const sum = sorted.reduce((acc, p) => acc + p.percent, 0);
  if (sum !== 100) {
    throw new Error(`상금 비율의 합이 100이어야 합니다 (현재 ${sum}).`);
  }

  return sorted;
}

/**
 * 풀을 등수별 금액으로 나눈다.
 *
 * 2위 이하를 먼저 내림으로 확정하고 **1위가 나머지를 흡수한다.** 각자 따로
 * 내림하면 나머지 원이 어디에도 속하지 않고 사라진다 — 사이드팟 증발(T15)과
 * 같은 모양이다. 이렇게 두면 `합계 === 풀`이 구조적으로 성립한다.
 */
export function calculatePrizes(
  pool: number,
  payouts: PrizePayout[],
): Map<number, number> {
  const sorted = [...payouts].sort((a, b) => a.place - b.place);
  const prizes = new Map<number, number>();

  let rest = 0;
  for (const { place, percent } of sorted.slice(1)) {
    const amount = Math.floor((pool * percent) / 100);
    prizes.set(place, amount);
    rest += amount;
  }

  prizes.set(sorted[0].place, pool - rest);
  return new Map([...prizes].sort((a, b) => a[0] - b[0]));
}

/**
 * DB에 Json으로 들어 있는 분배율에서 한 등수의 상금을 꺼낸다.
 *
 * 상금권 밖이면 0이다. `itmCount`와 따로 비교하지 않는 이유는, itmCount가
 * 분배율에서 파생된 값이라 "몫이 있는가"와 "인 더 머니인가"가 같은 질문이기
 * 때문이다. 두 군데서 판정하면 어긋날 수 있다.
 */
export function prizeFor(pool: number, payouts: unknown, place: number): number {
  if (!Array.isArray(payouts) || payouts.length === 0) return 0;
  return calculatePrizes(pool, payouts as PrizePayout[]).get(place) ?? 0;
}
