/**
 * 목업 결제의 승인 판정과 게이팅.
 *
 * **실 PG 연동 계획이 없다**(2026-08-20). 그래서 만들지 않는 것을 먼저 적는다.
 *
 * - 멱등성 키를 두지 않는다. PG 웹훅 재시도가 없으면 이중 충전이 성립하지 않는다.
 * - 금액 출처를 서버로 올리지 않는다. 승인 금액을 PG가 정하는 구조가 없다.
 * - 외부 거래 id 컬럼을 만들지 않는다.
 *
 * 셋 다 실결제를 전제해야 값을 한다. 나중에 PG가 생기면 그때 입구를 만든다 —
 * 도메인 연산(`increment` + `CHARGE` 거래 내역)은 어느 쪽이든 같으므로 그
 * 비용은 크지 않다.
 *
 * **이 파일이 있는 이유는 "가짜 결제"가 아니라 거절이다.** 부하는 지금까지
 * 결제 실패를 한 번도 밟은 적이 없어서, 거절 뒤에 참가 행 · 참가 OTP · 거래
 * 내역 · 프라이즈풀이 안 남는지를 아무도 재지 않았다(T72).
 */

/**
 * 거절을 부르는 나머지. **금액 % 1000이 이 값이면 승인하지 않는다.**
 *
 * 확률이 아니라 금액으로 가르는 이유는 재현성이다. 비율이면 같은 무대를 두 번
 * 돌려도 거절 수가 달라져 부하 결과를 나란히 못 놓는다. 금액이면 봇이 거절을
 * 부를 수 있고(`load/lib/api.js`), 통합 테스트가 같은 규칙으로 같은 거절을
 * 부른다. PG 샌드박스가 테스트 카드 번호로 실패를 부르는 것과 같은 모양이다.
 *
 * **상수로 내보낸다.** 손으로 999를 여러 곳에 적으면 규칙을 바꾸는 순간
 * 한쪽이 조용히 어긋난다.
 */
export const DECLINE_REMAINDER = 999;

/** 나머지를 재는 단위. */
const DECLINE_MODULUS = 1000;

export interface ChargeApproval {
  approved: boolean;
  /** 거절일 때만 있다. 화면과 부하 로그가 읽는다. */
  reason?: string;
}

/**
 * 승인 판정. **포인트를 건드리지 않는다.**
 *
 * 판정과 반영을 갈라 두는 것이 이 함수의 값어치다. 지금은 규칙이 한 줄이어도,
 * 그 경계가 있어야 나중에 실패를 끼워 넣을 자리가 생긴다.
 */
export function approveCharge(amount: number): ChargeApproval {
  if (amount % DECLINE_MODULUS === DECLINE_REMAINDER) {
    return { approved: false, reason: '카드사에서 승인을 거절했습니다.' };
  }
  return { approved: true };
}

type Env = { MOCK_PAYMENT?: string };

/**
 * 목업 결제를 켤 것인가.
 *
 * **꺼져 있으면 라우트가 존재하지 않아야 한다.** 요청 시점 가드가 아니라
 * 모듈 등록 시점에 갈라야 설정이 곧 방어가 된다 — `app.module.ts`의
 * `LOAD_METRICS`가 이미 같은 모양이다.
 *
 * `'1'`만 켜짐으로 읽는다. 참 같은 문자열을 전부 받아 주면
 * `MOCK_PAYMENT=false`가 켜지고, 그 실수의 대가가 **포인트를 늘리는
 * 라우트**다.
 */
export function mockPaymentEnabled(env: Env = process.env): boolean {
  return env.MOCK_PAYMENT === '1';
}
