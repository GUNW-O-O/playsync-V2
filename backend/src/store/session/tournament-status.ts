import { TournamentStatus } from '@prisma/client';

/**
 * **닫힌 대회다 — 어떤 운영 조작도 받지 않는다.**
 *
 * 판정을 한 곳에 두는 이유가 이 리포에 이미 사례로 있다. `user.service.ts`의
 * `getMyParticipations` 주석이 그것이다 — "상태를 나열해서 살아있는 것만
 * 고르면, 나중에 상태가 하나 늘 때 조용히 빠진다". `SYNCING`이 실제로 그랬다.
 *
 * T49가 `CANCELLED`를 추가하면서 같은 함정이 여덟 곳에 한꺼번에 생겼다.
 * `status === FINISHED`로 거절하던 자리들은 전부 취소된 대회를 **통과시킨다** —
 * 이미 환불까지 끝난 대회에 딜러가 로그인하고, 손님이 참가비를 내고, 상점이
 * 테이블을 연다. 그 여덟 곳을 이 함수 하나로 모은다.
 *
 * `SYNCING`은 닫힌 것이 아니다. 테이블 이동 대기라 대회는 살아 있다.
 */
export function isClosedTournament(status: TournamentStatus): boolean {
  return status === TournamentStatus.FINISHED || status === TournamentStatus.CANCELLED;
}
