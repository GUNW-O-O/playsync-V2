import { z } from "zod";

/**
 * 서버 복구 중 기기 복귀 진행 — 딜러와 좌석(T96 · T117). 그 대회의 딜러에게만 간다.
 *
 * `present`/`required`는 딜러 + 앉은 자리의 기기 수다(T117 전에는 딜러 수였다).
 *
 * **스냅샷 필드가 아니라 별도 이벤트다.** 대회 단위 정보라 테이블 스냅샷에
 * 실으면 테이블마다 같은 값을 들고 어긋날 수 있다(`tournamentClosed`와 같은 판단).
 *
 * `syncing: false`는 **서버가 `SYNCING`을 끝냈다**는 뜻이다 — `present === required`만
 * 보고 버튼을 열면, 서버가 아직 끝내지 못한 순간에 누른 재개가 거절된다.
 */
/**
 * 왜 멈췄나(T121). 없으면 서버 장애다. `lineDown`은 대회장의 회선이 끊겨 그 대회의
 * 딜러가 전부 사라진 경우다. 차례가 없던 테이블은 스냅샷에 정지 표시
 * (`resumePending`)가 없어, 대회 단위로도 실어야 그 테이블의 딜러와 상점이 원인을 본다.
 */
const SyncReasonSchema = z.literal("lineDown").optional();

export const TournamentSyncingSchema = z.object({
  syncing: z.boolean(),
  present: z.int().min(0),
  required: z.int().min(0),
  reason: SyncReasonSchema,
});
export type TournamentSyncing = z.infer<typeof TournamentSyncingSchema>;
export const TOURNAMENT_SYNCING_EVENT = "tournamentSyncing" as const;

/**
 * 상점 콘솔의 복구 상태(T117, `GET store/sessions/:id/sync`). 끝내 안 돌아오는 자리가
 * 있으면 상점이 이 목록을 보고 「지금 진행」으로 푼다. 테이블 번호 · 닉네임은 콘솔이
 * 이미 받는 좌석 목록으로 잇는다 — 여기 싣지 않는다.
 */
export const SyncStatusSchema = z.object({
  syncing: z.boolean(),
  present: z.int().min(0),
  required: z.int().min(0),
  missing: z.array(
    z.object({
      tableId: z.string(),
      /** `null`이면 그 테이블의 딜러다. */
      seatIndex: z.int().min(0).nullable(),
    }),
  ),
  reason: SyncReasonSchema,
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
