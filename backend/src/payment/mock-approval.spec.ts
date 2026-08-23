import { DECLINE_REMAINDER, approveCharge, mockPaymentEnabled } from './mock-approval';

/**
 * 목업 승인 판정.
 *
 * **실 PG 연동 계획이 없다**(2026-08-20, `tickets-audit.md`의 T72). 그래서
 * 멱등성 키도, 승인 금액을 서버가 정하는 구조도, 외부 거래 id도 만들지
 * 않는다 — 셋 다 실결제를 전제해야 값을 하고, 지금 지으면 쓰지 않을 것의
 * 유지 비용만 낸다.
 *
 * 남는 것은 하나다. **부하가 거절을 한 번도 밟은 적이 없다.**
 */
describe('approveCharge', () => {
  it('보통 금액은 승인한다', () => {
    expect(approveCharge(10_000).approved).toBe(true);
  });

  /**
   * **비율이 아니라 금액으로 가른다.** 확률이면 같은 무대를 두 번 돌려도
   * 거절 수가 달라져 부하 결과를 나란히 못 놓는다. 금액이면 봇이 거절을
   * 부를 수 있고, 통합 테스트가 같은 규칙으로 같은 거절을 부른다.
   *
   * PG 샌드박스가 테스트 카드 번호로 실패를 부르는 것과 같은 모양이다.
   */
  it('끝 세 자리가 999인 금액은 거절한다', () => {
    expect(approveCharge(9_999).approved).toBe(false);
    expect(approveCharge(999).approved).toBe(false);
    expect(approveCharge(1_000_999).approved).toBe(false);
  });

  it('거절에는 사람이 읽을 사유가 붙는다', () => {
    expect(approveCharge(9_999).reason).toEqual(expect.any(String));
  });

  it('승인에는 사유가 없다 — 있을 이유가 없다', () => {
    expect(approveCharge(10_000).reason).toBeUndefined();
  });

  /**
   * 규칙을 상수로 내보내는 이유는 부하 봇과 통합 테스트가 **같은 값**을
   * 봐야 하기 때문이다. 손으로 999를 두 곳에 적으면 규칙을 바꾸는 순간
   * 한쪽이 조용히 어긋난다.
   */
  it('나머지 규칙을 상수로 내보낸다', () => {
    expect(approveCharge(DECLINE_REMAINDER).approved).toBe(false);
  });
});

/**
 * 게이팅.
 *
 * 프로덕션이 없으므로 환경변수 하나로 충분하다. 다만 **변수가 없을 때
 * 라우트가 존재하지 않아야** 한다 — 그래야 설정이 곧 방어가 된다.
 * `app.module.ts`의 `LOAD_METRICS`가 이미 같은 모양이다.
 */
describe('mockPaymentEnabled', () => {
  it('변수가 없으면 꺼져 있다', () => {
    expect(mockPaymentEnabled({})).toBe(false);
  });

  it("'1'일 때만 켠다", () => {
    expect(mockPaymentEnabled({ MOCK_PAYMENT: '1' })).toBe(true);
  });

  /**
   * `'0'`·`'false'`·`'true'`를 켜짐으로 읽지 않는다. 참 같은 문자열을
   * 전부 받아 주면 `MOCK_PAYMENT=false`가 켜진다 — 배포에서 실제로 겪는
   * 실수고, 그 실수의 대가가 **포인트를 늘리는 라우트**다.
   */
  it('참 같은 다른 문자열은 켜지지 않는다', () => {
    expect(mockPaymentEnabled({ MOCK_PAYMENT: 'true' })).toBe(false);
    expect(mockPaymentEnabled({ MOCK_PAYMENT: '0' })).toBe(false);
    expect(mockPaymentEnabled({ MOCK_PAYMENT: 'false' })).toBe(false);
  });
});
