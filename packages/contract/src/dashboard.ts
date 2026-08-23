import { z } from "zod";

/**
 * 전광판(`GET /playsync/dashboard/:tournamentId`) 응답의 **공개형**.
 *
 * 아웃바운드라 `.strict()`를 걸지 않는다. zod 기본 스트립이 곧 그물이다 —
 * 백엔드 `Dashboard`(`backend/shared/types/tournamentMeta.ts`)에 필드를
 * 추가해도 여기 없으면 조용히 제거되므로 내부 값이 자동으로 새지 않는다
 * (CLAUDE.md의 contract 규칙, `table-state.ts` 머리말과 같은 이유다).
 *
 * 칩·금액은 정수다.
 */
const chips = z.int().min(0);

/** 전광판에 뜨는 등수별 상금. 비율은 대회 생성 시 정해지고 금액은 파생된다. */
export const PrizeRowSchema = z.object({
  place: z.int().min(1),
  percent: z.number(),
  amount: chips,
});

export type PrizeRow = z.infer<typeof PrizeRowSchema>;

export const DashboardSchema = z.object({
  isRegistrationOpen: z.boolean(),
  totalPlayer: z.int().min(0),
  activePlayer: z.int().min(0),
  totalBuyinAmount: chips,
  rebuyUntil: z.int(),
  avgStack: chips,
  tournamentName: z.string(),
  entryFee: chips,
  startStack: chips,
  itmCount: z.int().min(0),
  // 상점이 걷은 총액에서 가져가는 비율(%). **참가자가 따로 내는 수수료가
  // 아니다** — 참가비는 그대로 걷히고 대회를 닫을 때 총액에 한 번 곱해 뗀다.
  // 화면은 이 값을 그리지 않지만, 프라이즈풀이 왜 걷은 총액보다 작은지가 여기 있다.
  rakePercent: z.int().min(0).max(100),
  // 프라이즈풀은 걷은 참가비 총액에서 **상점 몫을 뺀 나머지**다. 지급의
  // 진실은 DB고, 이 둘은 전광판용 파생값이다 — 어긋나면 화면 숫자가 틀리는
  // 것이지 지급이 틀리는 것은 아니다. 레이크가 0이면 걷은 총액과 같다.
  prizePool: chips,
  prizes: z.array(PrizeRowSchema),
});

export type Dashboard = z.infer<typeof DashboardSchema>;

/**
 * 블라인드 구조 원소. `bb`는 없다(`sb * 2`로 파생), `duration`은 분 단위다.
 *
 * `lv`에 상한을 걸지 않는다 — **휴식 구간은 `lv === 99`인 원소다.** `.max()`를
 * 걸면 휴식 응답이 통째로 파싱에서 죽는다.
 */
export const BlindLevelSchema = z.object({
  lv: z.int().min(1),
  sb: chips,
  ante: z.boolean(),
  duration: z.int().min(1),
});

export type BlindLevel = z.infer<typeof BlindLevelSchema>;

/**
 * `currentBlindLv`는 레벨 번호가 아니라 `blindStructure`의 인덱스다
 * (`checkAndSyncBlindLevel`이 `calculated.currentIndex`를 그대로 넣는다).
 * 현재 블라인드는 `blindStructure[currentBlindLv]`고, 화면 분기는 `lv`를
 * 직접 보지 말고 서버가 계산해 준 `isBreak`를 쓴다.
 */
export const BlindFieldSchema = z.object({
  isBreak: z.boolean(),
  startedAt: z.int(),
  currentBlindLv: z.int().min(0),
  nextLevelAt: z.int(),
  serverTime: z.int(),
  blindStructure: z.array(BlindLevelSchema),
});

export type BlindField = z.infer<typeof BlindFieldSchema>;

export const FullTournamentInfoSchema = z.object({
  dashboard: DashboardSchema,
  blindField: BlindFieldSchema,
});

export type FullTournamentInfo = z.infer<typeof FullTournamentInfoSchema>;
