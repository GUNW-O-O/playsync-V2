import { TournamentStatus } from '@prisma/client';

/**
 * **닫힌 대회다 — 어떤 운영 조작도 받지 않는다.**
 *
 * 판정을 한 곳에 두는 이유가 이 리포에 이미 사례로 있다. `user.service.ts`의
 * `getMyParticipations` 주석이 그것이다 — "상태를 나열해서 살아있는 것만
 * 고르면, 나중에 상태가 하나 늘 때 조용히 빠진다". `SYNCING`이 실제로 그랬다
 * (선언만 돼 있고 아무도 대입하지 않아 T71에서 지웠다).
 *
 * T49가 `CANCELLED`를 추가하면서 같은 함정이 여덟 곳에 한꺼번에 생겼다.
 * `status === FINISHED`로 거절하던 자리들은 전부 취소된 대회를 **통과시킨다** —
 * 이미 환불까지 끝난 대회에 딜러가 로그인하고, 손님이 참가비를 내고, 상점이
 * 테이블을 연다. 그 여덟 곳을 이 함수 하나로 모은다.
 *
 */
export const CLOSED_TOURNAMENT_STATUSES = [
  TournamentStatus.FINISHED,
  TournamentStatus.CANCELLED,
] as const;

export function isClosedTournament(status: TournamentStatus): boolean {
  return (CLOSED_TOURNAMENT_STATUSES as readonly TournamentStatus[]).includes(status);
}

/**
 * 조회에서 뺄 상태. **여집합이라 상태가 늘어도 살아 있는 쪽이 안 빠진다.**
 *
 * `in: [ONGOING, PENDING]`으로 나열하던 자리가 둘 있었다(T71 9-3). 그때
 * `SYNCING`이 살아 있는 상태였는데 목록에 없어서, 그 값이 붙는 순간 대회가
 * 상점의 참가 가능 목록과 딜러 조회에서 통째로 사라지게 돼 있었다 —
 * 위 주석이 경고하던 바로 그 함정이 코드에 그대로 있었다.
 */
export const NOT_CLOSED_TOURNAMENT_FILTER: { notIn: TournamentStatus[] } = {
  notIn: [...CLOSED_TOURNAMENT_STATUSES],
};

/**
 * 닫힌 대회에 쓰려다 거절당했다.
 *
 * 가드는 `where`에 `status`를 얹는 모양이라(`NOT_CLOSED_TOURNAMENT_FILTER`),
 * 걸리면 Prisma가 P2025 「필요한 레코드를 찾지 못했다」를 던진다. 그 문구는
 * **행이 없다**는 뜻이라 로그를 읽는 사람이 대회가 사라진 줄 안다 — 실제로는
 * 있고, 닫혀 있을 뿐이다.
 */
export const CLOSED_TOURNAMENT_WRITE = '닫힌 대회에는 쓸 수 없습니다.';

/**
 * P2025**만** 위 문구로 바꾼다.
 *
 * 전부 삼키면 연결 끊김이나 제약 위반이 「닫힌 대회」로 둔갑해, 정작 고쳐야 할
 * 원인이 로그에서 사라진다.
 */
export function asClosedTournamentWrite(e: unknown): never {
  if ((e as { code?: string }).code === 'P2025') throw new Error(CLOSED_TOURNAMENT_WRITE);
  throw e;
}
