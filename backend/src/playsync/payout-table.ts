import { BadRequestException } from '@nestjs/common';
import { parsePayouts, PrizePayout } from './prize';

/**
 * 참가 규모에 따라 상금권 인원이 늘어나는 규칙.
 *
 * **대회의 분배율은 고정값이 아니라 표에서 파생된다.** 예전에는
 * `Tournament.prizePayouts`가 생성 시점에 박힌 배열이었고 `itmCount`가 그
 * 길이를 복사해 들고 있었다. 그래서 20명이 오든 200명이 오든 상금권이 같았고,
 * 프라이즈풀만 커졌다.
 *
 * **분모는 사람 수가 아니라 엔트리 수다.** 홀덤 대회 구조표가 그렇게 적힌다
 * ("X entries → Y places paid"). 리바인 대회에서 50명이 두 번씩 사면 엔트리는
 * 100개이고 프라이즈풀도 100 바이인이다 — 그것을 50명 기준으로 나누면 상금
 * 하나하나가 바이인 대비 터무니없이 커진다. 코드 쪽 근거도 같다: 프라이즈풀이
 * `엔트리 × entryFee`인데 상금권 인원을 `totalPlayers`에서 뽑으면 **분모가
 * 둘이 되고**, 리바인이 많은 대회일수록 둘이 벌어진다.
 *
 * **굳히는 코드가 없다.** 리바인은 등록 마감과 함께 끝나므로
 * (`resolveWinners`가 `isRegistrationOpen`으로 막는다) 마감 뒤에는
 * `totalBuyinAmount`가 불변이고, 따라서 엔트리 수도 분배율도 저절로 고정된다.
 * 굳히는 시점을 따로 두면 그 값과 파생값이 두 벌이 된다.
 */

/** 표의 한 구간. */
export interface PayoutTier {
  /** 이 구간이 적용되는 **최소 엔트리 수**. 경계는 포함이다. */
  minEntries: number;
  /** 그 구간의 분배율. 합이 100이고 등수가 1부터 연속한다. */
  payouts: PrizePayout[];
}

/**
 * 상점이 표를 안 주면 쓰는 기본표.
 *
 * **상위 10~15%가 상금권**이라는 것이 홀덤 관례다 — WSOP가 15%, 라이브 룸이
 * 대개 10~12%. 소규모일수록 비율이 커지는데, 5명 대회에서 10%는 0명이 되기
 * 때문이다.
 *
 * 곡선은 **필드가 커질수록 완만해진다.** 소규모는 우승자에게 몰아주고
 * 대규모는 넓게 퍼뜨린다 — 100명이 모인 대회에서 1등이 절반을 가져가면
 * 나머지 여덟 자리가 참가비를 겨우 넘긴다.
 */
export const DEFAULT_PAYOUT_TABLE: PayoutTier[] = [
  { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
  { minEntries: 6, payouts: [{ place: 1, percent: 65 }, { place: 2, percent: 35 }] },
  {
    minEntries: 10,
    payouts: [
      { place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 },
    ],
  },
  {
    minEntries: 16,
    payouts: [
      { place: 1, percent: 40 }, { place: 2, percent: 30 },
      { place: 3, percent: 20 }, { place: 4, percent: 10 },
    ],
  },
  {
    minEntries: 25,
    payouts: [
      { place: 1, percent: 40 }, { place: 2, percent: 25 }, { place: 3, percent: 17 },
      { place: 4, percent: 11 }, { place: 5, percent: 7 },
    ],
  },
  {
    minEntries: 36,
    payouts: [
      { place: 1, percent: 38 }, { place: 2, percent: 23 }, { place: 3, percent: 15 },
      { place: 4, percent: 10 }, { place: 5, percent: 8 }, { place: 6, percent: 6 },
    ],
  },
  {
    minEntries: 50,
    payouts: [
      { place: 1, percent: 35 }, { place: 2, percent: 21 }, { place: 3, percent: 14 },
      { place: 4, percent: 10 }, { place: 5, percent: 8 }, { place: 6, percent: 7 },
      { place: 7, percent: 5 },
    ],
  },
  {
    minEntries: 70,
    payouts: [
      { place: 1, percent: 30 }, { place: 2, percent: 20 }, { place: 3, percent: 14 },
      { place: 4, percent: 10 }, { place: 5, percent: 8 }, { place: 6, percent: 6 },
      { place: 7, percent: 5 }, { place: 8, percent: 4 }, { place: 9, percent: 3 },
    ],
  },
];

/**
 * 걷은 돈이 몇 번의 바이인인가.
 *
 * `recalculateAvgStack`이 총 칩을 셀 때 쓰는 것과 같은 역산이다. `entryFee`는
 * 걷은 돈이 있으면 못 바꾸므로(`updateSession`) 나눗셈이 언제나 정확히 떨어진다.
 *
 * **0으로 나누지 않는다.** 참가비 0은 DTO가 막지만(`ENTRY_FEE_MIN`), 여기서
 * `Infinity`가 나오면 구간 조회가 조용히 표의 마지막을 고른다.
 */
export function entryCountOf(totalBuyinAmount: number, entryFee: number): number {
  if (entryFee <= 0 || totalBuyinAmount <= 0) return 0;
  return Math.floor(totalBuyinAmount / entryFee);
}

/**
 * 그 규모에 적용되는 분배율.
 *
 * **경계는 포함이다** — 「10명 이상」 구간은 10에서 시작한다. 표는 0에서
 * 시작하도록 검증되므로(`parsePayoutTable`) 답이 없는 입력이 없다.
 */
export function payoutsFor(entryCount: number, table: PayoutTier[]): PrizePayout[] {
  let chosen = table[0];
  for (const tier of table) {
    if (tier.minEntries > entryCount) break;
    chosen = tier;
  }
  return chosen.payouts;
}

/**
 * 표를 검증한다. **대회 생성 시점에 막는 것이 요점이다.**
 *
 * 구간마다 분배율 검증을 다시 태운다(`parsePayouts`). 표 하나에 구간이
 * 여덟이면 잘못된 구간이 여덟 중 하나일 수 있고, 그 구간은 **그 규모의 대회가
 * 실제로 열릴 때까지 안 드러난다** — 100명이 모인 날 상금 지급이 터진다.
 *
 * **오름차순 검사는 정렬 전 입력을 본다.** 뒤섞인 표를 조용히 고쳐 주면
 * 상점이 자기가 무엇을 적었는지 모른 채 대회를 연다.
 */
export function parsePayoutTable(raw: unknown): PayoutTier[] {
  const tiers = (raw ?? []) as PayoutTier[];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('상금 구간표가 비어 있습니다.');
  }

  if (tiers[0].minEntries !== 0) {
    throw new Error('상금 구간표의 첫 구간은 엔트리 0에서 시작해야 합니다.');
  }

  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minEntries <= tiers[i - 1].minEntries) {
      throw new Error('상금 구간표는 엔트리 수 오름차순이어야 합니다.');
    }
  }

  return tiers.map((tier) => ({
    minEntries: tier.minEntries,
    payouts: parsePayouts(tier.payouts ?? []),
  }));
}

/**
 * 대회를 시작하려면 상금 구간표가 있어야 한다.
 *
 * 생성 경로는 이미 막고 있지만, 컬럼 기본값이 `[]`라 그 이전에 만들어진 행은
 * 비어 있을 수 있다. 시작한 뒤에 발견하면 이미 사람이 다 앉은 뒤고, 더
 * 나쁘게는 상금을 지급하는 순간까지 아무도 모른다.
 *
 * **`prize.ts`가 아니라 여기 있다.** 저쪽에 두면 `prize.ts`가 이 파일을
 * import하고 이 파일이 `parsePayouts`를 import해 순환이 된다.
 */
export function startablePayoutTable(raw: unknown): PayoutTier[] {
  try {
    return parsePayoutTable(raw);
  } catch (e) {
    throw new BadRequestException(`상금 구간표가 올바르지 않습니다: ${(e as Error).message}`);
  }
}

/**
 * 지급 경로가 쓰는 **관대한** 조회. 표가 없으면 상금도 없다.
 *
 * **여기서 던지면 도는 대회가 멎는다.** `eliminatePlayer`는 핸드 정산 한가운데
 * 있어서, 표가 비었다고 예외를 올리면 그 트랜잭션이 통째로 되돌아가고 탈락이
 * 확정되지 않는다 — 고칠 방법이 그 시점에 없다.
 *
 * 소리내어 막는 자리는 시작 게이트다(`startablePayoutTable`). 표가 비어 있으면
 * 대회가 시작되지 않으므로 여기까지 오는 것은 그 게이트가 없던 시절에 만들어진
 * 행뿐이고, 그때의 동작이 「상금권 밖이면 0원」이었다(`prizeFor`가 빈 배열에
 * 0을 돌려준다). 그 동작을 그대로 둔다.
 */
export function payoutsForRaw(entryCount: number, raw: unknown): PrizePayout[] {
  const tiers = (raw ?? []) as PayoutTier[];
  if (!Array.isArray(tiers) || tiers.length === 0) return [];
  return payoutsFor(entryCount, tiers);
}
