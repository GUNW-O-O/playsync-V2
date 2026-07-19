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
/**
 * 상금을 지급한다. **돈이 대회 밖으로 나가는 유일한 지점이다.**
 *
 * 세 가지가 한 트랜잭션에 묶여야 한다.
 *
 * - 참가자 행의 순위·상태·금액 (대회 기록)
 * - 유저 포인트 (실제로 쓸 수 있는 돈)
 * - 거래 내역 (왜 올랐는지 설명하는 근거)
 *
 * 예전에는 첫 줄만 있었다. 참가비는 포인트에서 빠지는데 상금은 참가자 행에
 * 숫자로만 적혀서, 대회를 열 때마다 시스템이 포인트를 삼켰다.
 * `TransactionType.PRIZE`가 스키마에 있는데 쓰는 코드가 없던 것이 그 증거다.
 *
 * **멱등이어야 한다.** 재시도가 붙은 뒤로 중복 도착은 정상 경로고(N-7),
 * 카운터와 달리 돈은 두 번 들어가면 되돌릴 근거가 없다. 이미 지급된
 * (`AWARDED`) 행은 건너뛴다 — 판정을 코드가 아니라 `where` 조건으로 DB에
 * 맡기는 것이 멱등성의 전부다.
 *
 * @returns 실제로 지급한 인원 수. 0이면 전부 이미 지급된 것이다.
 */
export async function awardPrize(
  tx: PrizeTx,
  tournamentId: string,
  awards: { userId: string; place: number; amount: number }[],
  description: string,
): Promise<number> {
  let paid = 0;

  for (const { userId, place, amount } of awards) {
    const changed = await tx.tournamentParticipation.updateMany({
      where: {
        tournamentId,
        userId,
        status: { notIn: ['ELIMINATED', 'AWARDED'] },
      },
      data: {
        finalPlace: place,
        status: amount > 0 ? 'AWARDED' : 'ELIMINATED',
        prizeAmount: amount,
      },
    });

    // 이미 처리된 사람이다. 포인트도 내역도 건드리지 않는다.
    if (changed.count === 0) continue;
    paid += changed.count;

    // 상금권 밖은 기록만 남기고 돈은 움직이지 않는다.
    if (amount <= 0) continue;

    await tx.user.update({
      where: { id: userId },
      data: { points: { increment: amount } },
    });
    await tx.pointTransaction.create({
      data: { userId, amount, type: 'PRIZE', tournamentId, description },
    });
  }

  return paid;
}

/** `awardPrize`가 쓰는 트랜잭션 클라이언트의 최소 형태. */
export interface PrizeTx {
  tournamentParticipation: { updateMany(args: unknown): Promise<{ count: number }> };
  user: { update(args: unknown): Promise<unknown> };
  pointTransaction: { create(args: unknown): Promise<unknown> };
}

export function prizeFor(pool: number, payouts: unknown, place: number): number {
  if (!Array.isArray(payouts) || payouts.length === 0) return 0;
  return calculatePrizes(pool, payouts as PrizePayout[]).get(place) ?? 0;
}
