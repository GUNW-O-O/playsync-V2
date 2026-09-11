import { z } from "zod";

/**
 * 대회 상태 전체. **프론트가 라벨을 `Record<TournamentStatus, string>`으로
 * 들게 하려고 둔다**(T96).
 *
 * 문자열로 받아 `if`로 가르면 상태가 늘 때 새 값이 폴백으로 조용히 떨어진다 —
 * `SYNCING`이 참가자 폰에 「종료」로 뜰 뻔했다. `Record`는 키가 빠지면 컴파일
 * 에러다. 값이 Prisma enum과 같은지는 백엔드 스펙이 대조한다
 * (`tournament-status.spec.ts`).
 */
export const TournamentStatusSchema = z.enum(["PENDING", "ONGOING", "SYNCING", "FINISHED", "CANCELLED"]);
export type TournamentStatus = z.infer<typeof TournamentStatusSchema>;
