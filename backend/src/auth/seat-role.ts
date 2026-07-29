/**
 * 좌석 토큰의 역할.
 *
 * Prisma `Role` enum에 넣지 않는다. `Role`은 `User` 행의 속성이라 "이 사람은
 * 플레이어다"를 적는 곳이고, 여기 적을 것은 "이 토큰은 좌석 하나짜리다"라는
 * 토큰의 성질이다.
 *
 * enum 밖에 두는 것이 곧 권한 경계다. `RolesGuard`는
 * `requiredRoles.includes(user.role)`로 판정하므로(`guard/roles.guard.ts`),
 * 이 값은 어떤 `@Roles(...)` 목록과도 맞지 않아 돈·신원 라우트에서 전부
 * 거부된다. 좌석 토큰이 지나갈 수 있는 곳은 역할을 요구하지 않는 라우트
 * — 게임 경로(`/playsync/*`)와 WS 티켓 발급뿐이다.
 */
export const SEAT_ROLE = 'PLAYER';

export type SeatTokenPayload = {
  sub: string;
  tournamentId: string;
  tableId: string;
  seatIndex: number;
  role: typeof SEAT_ROLE;
};
