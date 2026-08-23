import { PlayerStatus } from '@prisma/client';
import { isFinishedParticipant } from './player-status';

/**
 * 대회를 끝내면서 남은 돈을 여럿에게 나누는 계산.
 *
 * **이 파일이 두 번 쓰인다.** 지금은 중단 정산이 쓰고, ICM 찹이 같은 자리를
 * 쓴다 — 둘 다 "대회를 끝내면서 남은 돈을 나눈다"이고 다른 것은 **무슨 비율로
 * 나누는가**뿐이다. 중단은 각자가 낸 돈이 비율이고, 찹은 각자의 칩이다.
 * 그래서 비율로 나누는 부분(`splitByRatio`)만 아래에 따로 세워 둔다.
 *
 * **계산과 지급을 가른다.** 여기는 순수 함수뿐이고 DB를 모른다 — 돈이 얼마씩
 * 가는가는 테스트하기 쉬운 성질이라야 하고, 그 판단이 트랜잭션 안에 섞이면
 * 인프라를 띄워야만 검증할 수 있게 된다.
 */

/** 나눌 몫의 크기. `weight`가 0이면 아무것도 받지 않는다. */
export interface RatioWeight {
  userId: string;
  weight: number;
}

/**
 * `amount`를 가중치 비율대로 나눈다. **합은 정확히 `amount`다.**
 *
 * 각자 내림하면 나머지 한 단위가 어디에도 속하지 않고 사라진다 — 사이드팟
 * 증발(T15)과 같은 모양이고, `calculatePrizes`가 1위에 나머지를 몰아 준 것도
 * 같은 이유다. 여기서는 몰아 주는 대신 **소수부가 큰 순서로** 한 단위씩
 * 돌린다. 몰아 주면 인원이 많을 때 한 사람에게 티가 나게 쏠린다.
 *
 * 소수부가 같으면 **입력 순서**가 정한다. 호출자가 순서를 정해 두면 결과가
 * 재현되고, 정하지 않았으면 어차피 구분할 근거가 없다.
 */
export function splitByRatio(
  amount: number,
  weights: RatioWeight[],
): { userId: string; amount: number }[] {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0 || amount <= 0) {
    return weights.map(({ userId }) => ({ userId, amount: 0 }));
  }

  const shares = weights.map(({ userId, weight }, index) => {
    const exact = (amount * weight) / total;
    const floor = Math.floor(exact);
    return { userId, index, amount: floor, remainder: exact - floor };
  });

  let rest = amount - shares.reduce((sum, s) => sum + s.amount, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (const share of byRemainder) {
    if (rest <= 0) break;
    share.amount += 1;
    rest -= 1;
  }

  return shares.map(({ userId, amount: share }) => ({ userId, amount: share }));
}

/** 정산이 참가 한 건에서 실제로 읽는 것만. */
export interface SettlementParticipant {
  userId: string;
  status: PlayerStatus;
  /** 참가비를 낸 횟수. 리바인이 올린다. */
  buyInCount: number;
  /** 이 대회에서 이미 받은 상금. */
  prizeAmount: number;
}

/**
 * 중단 환불 비율(%).
 *
 * **아직 지지 않은 사람과 이미 진 사람을 같이 볼 수는 없다.** 중단은 대회사의
 * 사정이라 나간 사람에게도 얼마간 주는 것이 맞지만, 살아 있는 사람과 같은
 * 비율이면 탈락이 아무 의미가 없어진다. **등록 마감 전후를 가리지 않는다** —
 * 마감 전에 나간 사람이라고 덜 진 것이 아니다.
 */
export const ABORT_REFUND_PERCENT = { live: 100, finished: 50 } as const;

/** 중단 정산의 결과. */
export interface AbortSettlement {
  /** 각자에게 돌려줄 금액. 참가자 순서를 그대로 유지한다. */
  refunds: { userId: string; amount: number }[];
  /** 나가고 남은 돈. 상점 주인이 갖는다. */
  storeAmount: number;
  /** 남은 돈이 모자라 환불을 깎았나. 운영이 알아야 하는 사실이다. */
  scaled: boolean;
}

/**
 * 진행 중인 대회를 중단할 때 각자에게 돌려줄 금액을 정한다.
 *
 * 세 걸음이다.
 *
 * 1. **각자의 희망액.** 낸 총액(`entryFee × buyInCount`)에 상태별 비율을
 *    곱하고, **이미 받은 상금을 뺀다.** 상금도 이 대회의 돈에서 나갔으므로
 *    빼지 않으면 같은 사람이 같은 풀에서 두 번 가져간다. 음수면 0이다 —
 *    **회수하지 않는다.** 이미 준 돈을 도로 가져가는 경로는 만들지 않는다.
 * 2. **낼 수 있는 돈.** 걷은 돈에서 이미 나간 상금을 뺀 것.
 * 3. **모자라면 비율대로 깎는다.** 상금이 크게 나간 뒤에 중단하면 남은 돈이
 *    희망액 합보다 적을 수 있다. 그때 거절하면 **닫을 수 없는 대회**가
 *    남는데, 이 리포는 그것을 결함으로 다뤄 왔다(파이널 테이블 킥, T77).
 *    낼 수 있는 만큼만 나가고 대회는 반드시 닫힌다.
 *
 * 남으면 상점 몫이다. 갈 곳을 정해 두지 않으면 그 돈이 장부에서 사라진다.
 *
 * @param entryFee 대회의 참가비. `Tournament.entryFee`
 * @param totalBuyinAmount 걷은 총액. 돈의 진실은 DB다(`domain.md`)
 */
export function calculateAbortSettlement(
  participants: SettlementParticipant[],
  entryFee: number,
  totalBuyinAmount: number,
): AbortSettlement {
  const paidPrizes = participants.reduce((sum, p) => sum + p.prizeAmount, 0);
  const available = Math.max(0, totalBuyinAmount - paidPrizes);

  const claims = participants.map((p) => {
    const percent = isFinishedParticipant(p.status)
      ? ABORT_REFUND_PERCENT.finished
      : ABORT_REFUND_PERCENT.live;
    const paid = entryFee * p.buyInCount;
    return {
      userId: p.userId,
      weight: Math.max(0, Math.floor((paid * percent) / 100) - p.prizeAmount),
    };
  });

  const wanted = claims.reduce((sum, c) => sum + c.weight, 0);

  if (wanted <= available) {
    return {
      refunds: claims.map(({ userId, weight }) => ({ userId, amount: weight })),
      storeAmount: available - wanted,
      scaled: false,
    };
  }

  return {
    refunds: splitByRatio(available, claims),
    storeAmount: 0,
    scaled: true,
  };
}

/** 찹에 참여하는 한 사람. 칩은 장부(`TournamentParticipation.currentStack`)다. */
export interface ChopParticipant {
  userId: string;
  currentStack: number;
}

/**
 * ICM 찹 — 남은 사람들이 딜로 끝낸다.
 *
 * **파이널 테이블에서 지쳤을 때 하는 것이다.** 최후 1인까지 가지 않고 남은
 * 상금을 각자의 칩 비율로 나눈다. 오프라인 대회에서 흔한 마무리라, 그 경로가
 * 없으면 딜로 끝난 대회는 시스템이 닫지 못한다.
 *
 * **중단 정산과 같은 자리를 쓴다**(`splitByRatio`). 둘 다 "대회를 끝내면서
 * 남은 돈을 여럿에게 나눈다"이고 다른 것은 무슨 비율로 나누는가뿐이다 —
 * 중단은 각자가 낸 돈, 찹은 각자의 칩. 나머지 한 단위까지 보존하므로
 * **나눈 합이 정확히 남은 상금과 같고**, 그래야 `completeSession`의 게이트가
 * 열린다.
 *
 * **등수는 칩이 정한다.** 금액은 이미 비율로 갈렸지만 기록은 남아야 한다 —
 * 딜로 끝난 대회도 누가 1위였는지가 참가 행에 적힌다. 칩이 같으면 입력 순서가
 * 가르고, 그때는 금액도 같아서 구분할 근거가 어차피 없다.
 *
 * **상금 구조를 대체한다.** 남은 사람이 상금권 인원보다 많아도 전원이 나눈다 —
 * 딜은 남은 사람들의 합의이고, 아직 지지 않은 사람을 0원으로 내보내면 그
 * 사람이 딜에 동의할 이유가 없다.
 *
 * @param remainingPrize 프라이즈풀에서 이미 나간 상금을 뺀 나머지
 */
export function calculateChop(
  participants: ChopParticipant[],
  remainingPrize: number,
): { userId: string; place: number; amount: number }[] {
  const ordered = [...participants].sort((a, b) => b.currentStack - a.currentStack);
  const amounts = new Map(
    splitByRatio(
      remainingPrize,
      ordered.map(({ userId, currentStack }) => ({ userId, weight: currentStack })),
    ).map(({ userId, amount }) => [userId, amount]),
  );

  return ordered.map((p, index) => ({
    userId: p.userId,
    place: index + 1,
    amount: amounts.get(p.userId) ?? 0,
  }));
}

/**
 * 대회를 닫지 못하는 이유. 닫아도 되면 `null`이다.
 *
 * **게이트와 화면이 같은 문장을 쓰게 하려고 뗀 함수다.** 콘솔의 「종료」는
 * 못 누를 때 이유를 그 자리에 적는데(와이어프레임 「못 누를 때」), 그 이유를
 * 화면이 따로 계산하면 서버가 실제로 거절하는 조건과 어긋나는 날이 온다 —
 * 「닫을 수 있다」고 그려 놓고 누르면 409가 나는 화면이다. `completeSession`이
 * 던지는 문장과 미리보기가 그리는 문장이 여기 하나에서 나온다.
 *
 * 보는 것은 **「걷은 것 == 나간 상금 + 상점 몫」**이다. 상금만 보면 레이크가
 * 붙은 대회는 상점 몫만큼 늘 벌어져 영영 안 닫힌다. 레이크가 0이면 이 식이
 * 예전 식과 같아진다.
 */
export function completeBlocker(
  totalBuyinAmount: number,
  paidPrize: number,
  rake: number,
): string | null {
  const remaining = totalBuyinAmount - paidPrize - rake;
  if (remaining === 0) return null;

  // **자릿수를 끊어 준다.** 이 문장은 그대로 화면에 뜨는데(콘솔의 「왜 못
  // 누르나」), 「350000 남았습니다」는 한눈에 자릿수를 못 읽는다. 로케일에
  // 맡기지 않는 이유는 서버가 만든 문장이 실행 환경에 따라 달라지면 안
  // 되기 때문이다 — 화면과 로그와 테스트가 같은 문자열이라야 한다.
  const won = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return remaining > 0
    ? `상금 정산이 끝나지 않았습니다. ${won(remaining)} 남았습니다.`
    : `지급된 상금이 프라이즈풀보다 ${won(-remaining)} 많습니다.`;
}

/** 중단 환불의 무리. 순서는 고정이다 — 화면이 이 순서대로 줄을 그린다. */
export type AbortGroupKind = 'LIVE' | 'FINISHED' | 'PRIZED';

export interface AbortGroup {
  kind: AbortGroupKind;
  count: number;
  amount: number;
}

const ABORT_GROUP_ORDER: AbortGroupKind[] = ['LIVE', 'FINISHED', 'PRIZED'];

/**
 * 환불을 무리별 합으로 접는다.
 *
 * **누르는 사람이 확인할 수 있는 것은 규칙이지 사람마다의 금액이 아니다.**
 * 열여섯 줄을 그려 봐야 읽는 것은 「진행 중인 사람이 낸 돈 전부를 받는가」
 * 하나다. 그래서 확인 대화는 무리 셋과 상점 몫, 그리고 그 합이 걷은 돈과
 * 같은지를 보여준다.
 *
 * **상금을 받은 사람이 따로 선다.** `calculateAbortSettlement`이 그 사람의
 * 환불에서 받은 상금을 빼므로 대개 0원인데, 탈락 무리에 섞으면 그 무리의
 * 1인당이 절반 규칙과 어긋나 보인다. 살아 있든 탈락했든 상금이 먼저다 —
 * 파이널 테이블의 상금권은 `PLAYING`인 채로 상금을 들고 있다.
 *
 * **빈 무리도 남긴다.** 지우면 「빠뜨렸나」로 읽힌다. 0이라는 것이 결과다.
 */
export function groupAbortRefunds(
  participants: SettlementParticipant[],
  refunds: { userId: string; amount: number }[],
): AbortGroup[] {
  const amountByUser = new Map(refunds.map((r) => [r.userId, r.amount]));
  const groups = new Map<AbortGroupKind, AbortGroup>(
    ABORT_GROUP_ORDER.map((kind) => [kind, { kind, count: 0, amount: 0 }]),
  );

  for (const participant of participants) {
    const kind: AbortGroupKind = participant.prizeAmount > 0
      ? 'PRIZED'
      : isFinishedParticipant(participant.status)
        ? 'FINISHED'
        : 'LIVE';
    const group = groups.get(kind)!;
    group.count += 1;
    group.amount += amountByUser.get(participant.userId) ?? 0;
  }

  return ABORT_GROUP_ORDER.map((kind) => groups.get(kind)!);
}
