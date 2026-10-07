/**
 * 세대가 올라 옛 토큰이 죽은 소켓을 서버가 닫을 때의 코드와 이유(T110).
 *
 * 단말은 이 코드면 다시 붙지 않는다 — 붙어 봐야 티켓이 403이다. 1000(정상 종료)과
 * 가르는 이유는, 1000은 「대회가 끝났다」라 덮개가 다르기 때문이다.
 * WS 닫기 이유는 123바이트까지라 한글 40자 안쪽으로 둔다.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4001 as const;
export const SEAT_REVOKED_REASON = "다른 기기에서 이 좌석에 다시 들어왔습니다." as const;
export const DEALER_REVOKED_REASON = "상점이 딜러 연결을 해제했습니다." as const;
