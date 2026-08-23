/**
 * 파이널 테이블 판정(T77).
 *
 * **딜러 개입을 막는 자리가 여기다.** 파이널 테이블부터는 딜러의 킥과 폴드를
 * 둘 다 금지한다. 근거가 서로 다르다.
 *
 * **킥 금지는 인원수와 직결된다.** 킥은 참가를 `ELIMINATED`로 만들고
 * `activePlayers`를 깎는데, 최후 1인 판정(`tournamentFinished`)을 부르는 자리는
 * `PlaysyncService.eliminatePlayer` 하나뿐이다 — 킥은 그 길로 가지 않는다.
 * 그래서 헤즈업에서 킥이 일어나면 `activePlayers`가 1이 되는데 **아무도 그것을
 * 보고 대회를 닫지 않는다.** 대회가 열린 채 남고 `completeSession`은 정산이
 * 안 끝나 거절한다 — 나올 길이 없다. T60이 카운터를 DB로 옮기면서 이 구멍을
 * 봤지만 KICK 경로에 판정을 새로 달지 않았다(2026-08-21). 근거는 "이 규칙이
 * 서면 닫힌다"였고, 여기가 그 규칙이다.
 *
 * **폴드 금지는 카운터와 무관하다**(`hasFolded`만 세운다). 근거는 공정성이다 —
 * 남은 사람이 적어지면 딜러의 대리 조작이 결과를 직접 좌우한다. 자리를 비운
 * 사람은 턴 타임아웃(`TURN_TIMEOUT_MS`, 30초)이 자동으로 폴드시키므로 막아도
 * 판이 멎지 않는다.
 */

/**
 * 판정이 **실제로 읽는 것만** 받는다.
 *
 * `Tournament` 모델 전체를 받으면 `PrismaService`가 감추는 `dealerOtpHash`가
 * 빠진 행을 넘길 수 없고(T51), 그 필드는 이 판정과 아무 상관이 없다.
 * `PaymentService`의 `RegistrationGateSource`와 같은 이유다.
 */
export interface FinalTableSource {
  /** 등록이 아직 열려 있는가. `Tournament.isRegistrationOpen`. */
  isRegistrationOpen: boolean;
  /** 그 대회에 남아 있는 테이블 수. `table.count({ where: { tournamentId } })`. */
  tableCount: number;
}

/**
 * 파이널 테이블인가.
 *
 * **전이가 아니라 상태로 적는다.** "테이블이 2에서 1로 떨어지는 순간"으로
 * 적으면 그 순간을 놓친 재접속·복구가 판정을 잃는다. 상태로 두면 사람이 적어
 * **처음부터 테이블 하나로 연 대회**도 같은 조건에 걸린다 — 등록이 마감됐으면
 * 그것도 파이널 테이블이다.
 *
 * 테이블이 0이면 아니다. 딜러가 조작할 자리 자체가 없어서, `true`를 돌려주면
 * "파이널 테이블이라 막았다"는 안내가 나가는데 실제 원인은 다른 곳이다.
 */
export function isFinalTable({ isRegistrationOpen, tableCount }: FinalTableSource): boolean {
  return !isRegistrationOpen && tableCount === 1;
}

/**
 * 딜러에게 나가는 안내.
 *
 * 딜러 경로의 실패는 상태코드가 아니라 **메시지**로 나가므로
 * (`{ event: 'error', data: e.message }`) 문자열 자체가 안내다. 막았다는
 * 사실만 적으면 딜러는 자리를 비운 사람을 어떻게 처리해야 할지 모른 채
 * 멈춘다 — 그래서 대신 무엇이 일어나는지를 함께 적는다.
 */
export const FINAL_TABLE_DEALER_BLOCKED =
  '파이널 테이블에서는 딜러가 대신 폴드하거나 내보낼 수 없습니다. ' +
  '자리를 비운 사람은 제한시간이 지나면 자동으로 폴드됩니다.';
