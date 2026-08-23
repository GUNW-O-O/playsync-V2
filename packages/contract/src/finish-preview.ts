import { z } from "zod";

/**
 * 대회 마무리 미리보기(`GET /store/sessions/:id/finish-preview`)의 **공개형**.
 *
 * **셋을 한 봉투로 준다.** 콘솔의 마무리 영역은 종료·ICM·중단을 한 화면에
 * 그리고, 확인 대화 둘이 그 위에서 열린다. 라우트를 셋으로 나누면 화면이
 * 세 시점의 값을 섞어 그리게 되는데, 이 화면의 핵심이 **「합이 걷은 돈과
 * 같다」를 눈으로 확인하는 것**이라 그 순간 확인이 무의미해진다.
 *
 * **읽기 전용이다.** 지급도 상태 전이도 없다. 확정은 각 라우트가 서버에서
 * 다시 계산하므로 이 응답은 근거가 아니라 **미리 보여주는 그림**이다 —
 * 프론트가 이 값을 되돌려 보내지 않는다.
 *
 * 아웃바운드라 `.strict()`를 걸지 않는다. zod 기본 스트립이 그물이다.
 */
const chips = z.int().min(0);

/**
 * 조작 하나의 가부. `canRun`이 false면 `reason`이 **왜 못 하는지**를 든다.
 *
 * 화면이 버튼을 숨기지 않고 이유를 그 자리에 적는다 — 사라진 버튼은
 * "이 대회는 원래 종료가 없다"로 읽힌다. 그래서 이유가 응답에 있어야 하고,
 * 그 문장은 서버가 실제로 거절할 때 던지는 것과 같아야 한다.
 */
export const FinishGateSchema = z.object({
  canRun: z.boolean(),
  reason: z.string().nullable(),
});

/** ICM 찹 미리보기의 한 줄. 등수는 칩이 정한다. */
export const ChopRowSchema = z.object({
  userId: z.string(),
  /** `User.nickname`은 nullable이다. 없으면 화면이 `userId`로 그린다. */
  nickname: z.string().nullable(),
  place: z.int().min(1),
  currentStack: chips,
  amount: chips,
});

/**
 * 중단 환불의 무리별 합.
 *
 * - `LIVE` 진행 중 — 낸 돈 전부
 * - `FINISHED` 탈락 — 낸 돈 절반
 * - `PRIZED` 상금을 이미 받은 사람 — 받은 상금을 뺀 나머지(대개 0)
 *
 * 사람마다의 금액이 아니라 무리로 접는 이유는 `groupAbortRefunds`에 있다.
 */
export const AbortGroupSchema = z.object({
  kind: z.enum(['LIVE', 'FINISHED', 'PRIZED']),
  count: z.int().min(0),
  amount: chips,
});

export const FinishPreviewSchema = z.object({
  /** 걷은 참가비 총액. 확인 대화의 마지막 줄이고, 위 줄들의 합과 같아야 한다. */
  totalBuyinAmount: chips,
  rakePercent: z.int().min(0).max(100),
  /** 상점 몫의 **금액**. 비율만 주면 화면이 곱셈을 다시 하게 된다. */
  rakeAmount: chips,
  /** 상점 몫을 뺀 나머지(`prizePoolOf`). */
  prizePool: chips,
  /** 이미 나간 상금의 합. */
  paidPrize: chips,
  /** 아직 안 나간 상금. ICM이 나눌 돈이 이것이다. */
  remainingPrize: chips,
  complete: FinishGateSchema,
  chop: FinishGateSchema.extend({
    /** 못 하는 상태면 빈 배열이다 — 나눌 사람을 셀 근거가 없다. */
    rows: z.array(ChopRowSchema),
  }),
  abort: FinishGateSchema.extend({
    groups: z.array(AbortGroupSchema),
    /** 나가고 남는 돈. 상점 주인이 갖는다. */
    storeAmount: chips,
    /** 남은 돈이 모자라 환불을 깎았나. 운영이 알아야 하는 사실이다. */
    scaled: z.boolean(),
  }),
});

export type FinishPreview = z.infer<typeof FinishPreviewSchema>;
export type ChopRow = z.infer<typeof ChopRowSchema>;
export type AbortGroup = z.infer<typeof AbortGroupSchema>;
