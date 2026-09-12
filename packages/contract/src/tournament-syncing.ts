import { z } from "zod";

/**
 * 서버 복구 중 딜러 복귀 진행(`tournamentSyncing`, T96). 그 대회의 딜러에게만 간다.
 *
 * **스냅샷 필드가 아니라 별도 이벤트다.** 대회 단위 정보라 테이블 스냅샷에
 * 실으면 테이블마다 같은 값을 들고 어긋날 수 있다(`tournamentClosed`와 같은 판단).
 *
 * `syncing: false`는 **서버가 `SYNCING`을 끝냈다**는 뜻이다 — `present === required`만
 * 보고 버튼을 열면, 서버가 아직 끝내지 못한 순간에 누른 재개가 거절된다.
 */
export const TournamentSyncingSchema = z.object({
  syncing: z.boolean(),
  present: z.int().min(0),
  required: z.int().min(0),
});
export type TournamentSyncing = z.infer<typeof TournamentSyncingSchema>;
export const TOURNAMENT_SYNCING_EVENT = "tournamentSyncing" as const;
