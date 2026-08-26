import { z } from "zod";

/**
 * 대회가 닫혔다는 알림(`tournamentClosed`)의 **공개형**.
 *
 * ── 왜 별도 이벤트인가
 *
 * 지금까지 게이트웨이가 내보내는 것은 넷뿐이었다 — `renderGame` ·
 * `renderSeatList` · `REBUY_PROMPT` · `error`. 대회를 닫는 네 경로
 * (`completeSession` · `chopSession` · `abortSession` · `cancelSession`)는
 * **소켓에 아무것도 쓰지 않았고**, 그래서 딜러 화면은 끝난 줄 모르고 마지막
 * 스냅샷을 계속 그렸다. 딜러가 「핸드 시작」을 누르면 스냅샷도 `Table` 행도
 * 없어 서비스가 던지고, 딜러가 보는 것은 **「명령이 거절되었습니다」** 하나였다
 * — 끝났다는 사실이 아니라 정체불명의 에러다.
 *
 * **스냅샷 필드로 얹지 않았다.** `dbSyncStatus`처럼 `renderGame`에 태우는 길이
 * 먼저 떠오르지만, 닫는 트랜잭션이 `Table` 행과 Redis 스냅샷을 **지우면서**
 * 끝난다. 태울 스냅샷이 그 시점에 이미 없고, 지우기 전에 한 번 더 쏘는 것은
 * 순서에 기대는 배선이다 — 재접속 단말은 어차피 스냅샷이 없어 못 받는다.
 *
 * ── 무엇을 담나
 *
 * **화면이 그릴 수 있을 만큼만.** 「끝났다」와 「어떻게 끝났다」 둘이다.
 * 상금표도 등수도 넣지 않는다 — 그것은 참가자 폰(`/me`)의 일이고, 딜러
 * 태블릿은 다음 대회를 위해 대기 화면으로 돌아가는 것이 할 일이다.
 *
 * 아웃바운드라 `.strict()`를 걸지 않는다. zod 기본 스트립이 그물이다.
 */

/**
 * **닫힌 상태만 담는다.** `TournamentStatus` 넷 중 둘이다.
 *
 * `ONGOING`이 이 봉투에 실려 나가면 화면은 「끝났습니다」를 그리는데 대회는
 * 돌고 있다. 그 조합을 만들 길을 여기서 막는다 — enum 전체를 그대로 쓰면
 * 막을 자리가 어디에도 안 남는다.
 *
 * 둘을 하나로 합치지도 않는다. 「종료」는 걷은 참가비가 상금과 상점 몫으로 다
 * 나간 것이고 「취소」는 환불하고 무른 것이라, 딜러 화면이 적을 문장이 다르다.
 */
export const ClosedTournamentStatusSchema = z.enum(["FINISHED", "CANCELLED"]);

export const TournamentClosedSchema = z.object({
  tournamentId: z.string(),
  status: ClosedTournamentStatusSchema,
  /**
   * 서버가 닫은 시각(epoch ms). **단말이 자기 시계로 「방금」을 판단하지
   * 않게 한다** — `renderGame`의 `serverTime`이 있는 이유와 같다. 단말이
   * 대기 화면으로 돌아가기까지 카운트다운을 그리는데, 시계가 뒤처진 태블릿은
   * 그 값을 자기 시각과 비교해 음수를 얻는다.
   */
  closedAt: z.int(),
});

export type ClosedTournamentStatus = z.infer<typeof ClosedTournamentStatusSchema>;
export type TournamentClosed = z.infer<typeof TournamentClosedSchema>;
