import { Role } from '@prisma/client';
import { SEAT_ROLE } from './seat-role';

/**
 * 토큰 수명을 역할마다 따로 준다.
 *
 * **전역 1시간 하나였고, 그것이 대회 길이를 못 버텼다.** T41의 부하 램프가
 * 64분째부터 새 테이블마다 401을 받으며 드러났는데, 제품에서 더 아픈 쪽은
 * 좌석이다 — 좌석 토큰이 `POST /ws/ticket`에 쓰이므로 **한 시간이 지나면
 * 태블릿이 스스로 재접속하지 못한다.** 네 시간짜리 대회면 전원이 겪고,
 * 하필 T31이 만든 복구 시나리오(서버가 살아 돌아오면 전원 재접속)와 정면으로
 * 겹친다.
 *
 * 갱신 엔드포인트를 붙이지 않고 수명만 늘린다. 폐기는 수명이 아니라 세대로 한다 — 아래 참고.
 */

/** 폰·브라우저. 재로그인이 자연스럽고, 세션이 길 이유가 없다. */
const SHORT = '1h';

/**
 * 행사 내내 켜져 있는 단말. 좌석 태블릿, 딜러 태블릿, 상점 콘솔이다.
 *
 * 12시간인 이유는 **어느 대회도 그보다 길지 않기** 때문이다. 대회 종료 시각에
 * 묶는 방법도 있었는데 버렸다 — 대회가 늘어지면(레벨 연장, 헤즈업이 길어짐)
 * 정확히 가장 곤란한 순간에 다시 끊긴다.
 */
const LONG = '12h';

/**
 * **좌석 토큰은 수명을 늘려도 세대(`seatTokenVersion`)로 폐기한다**(T110).
 *
 * 권한 판정은 여전히 토큰이 아니라 **스냅샷**에 있다. 플레이어 경로는 토큰의
 * `tableId`를 아예 보지 않는다 — WS 접속은 `assertTableAccess`가
 * (`ws.gateway.ts`의 `assertTableAccess`), 액션은 `handleAction`이
 * 각각 "지금 이 테이블 스냅샷에 이 userId가 앉아 있는가"만 본다. 그래서
 * 좌석 해제(T29) · 탈락 · 테이블 이동 즉시 옛 토큰의 권한이 0이 된다.
 *
 * **그런데 해제된 사람이 다시 앉으면 옛 토큰이 되살아난다.** 스냅샷이 다시
 * 「앉아 있다」고 말하기 때문이다 — 탈취한 공격자의 토큰도 같이 산다. 그래서
 * 토큰에 세대를 단다. `TournamentParticipation.seatTokenVersion`은 입장
 * (`EntryService.enterSeat`)이 성공할 때와 좌석 해제(`SessionService.releaseSeats`)
 * 때 오르고, 토큰의 `ver`가 그 값과 다르면 죽은 토큰이다. 대조 자리는 둘이다 —
 * `POST /ws/ticket`(`WsTicketController.issue`)과 `handleConnection`(티켓 수명
 * 30초 사이의 틈). 이미 붙어 있는 소켓은 대조가 닿지 않으므로 세대를 올리는 쪽이
 * `SEAT_TOKENS_REVOKED`를 쏘고 게이트웨이가 닫는다(`WsGateway.closeWhere`).
 *
 * **딜러와 좌석 둘 다 세대를 갖는다.** 딜러 토큰은 `tableId`가 권위라
 * (`assertTableAccess`가 쿼리 값과 대조한다) 폐기가 토큰 레벨에 있어야 했고
 * (`tokenVersion`), 좌석은 권위가 스냅샷이어도 재착석이 토큰을 되살리므로
 * 세대가 필요하다.
 *
 * 남는 위협은 탈취뿐이고 그것은 1시간이어도 같은 종류다 — 수명은 창의 크기만
 * 바꾼다. 그리고 이 도메인에서 그 창은 작다: 행사장 망 안에 있어야 하고,
 * 피해자는 자기 태블릿 앞에 앉아 있고, 훔친 좌석 토큰으로 할 수 있는 것은
 * **피해자의 칩을 잃게 만드는 것**(폴드·슈브)뿐이다. 남에게 칩을 옮기려면
 * 딜러가 승자를 입력해야 하므로 딜러 태블릿까지 필요하다.
 *
 * `PLATFORM_ADMIN`은 길게 주지 않는다. 권한이 가장 크고, 행사장에 고정
 * 비치되는 단말이 아니다.
 */
export function tokenTtl(role: string): typeof SHORT | typeof LONG {
  switch (role) {
    case SEAT_ROLE:
    case Role.DEALER:
    case Role.STORE_ADMIN:
      return LONG;
    default:
      return SHORT;
  }
}
