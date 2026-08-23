import { isFinalTable } from './final-table';

/**
 * 파이널 테이블 판정(T77).
 *
 * **전이가 아니라 상태다.** "테이블이 2에서 1로 떨어지는 순간"으로 적으면 그
 * 순간을 놓친 재접속·복구가 판정을 잃는다. 상태로 두면 사람이 적어 처음부터
 * 테이블 하나로 연 대회도 같은 조건에 걸린다.
 */
describe('isFinalTable', () => {
  it('등록이 마감됐고 테이블이 하나면 파이널 테이블이다', () => {
    expect(isFinalTable({ isRegistrationOpen: false, tableCount: 1 })).toBe(true);
  });

  /**
   * **둘이 어긋나는 입력이 있어야 각각이 증명된다**(CLAUDE.md "두 검사가 서로를
   * 가렸다"). 아래 둘은 조건 하나씩만 어기므로, 어느 한 항을 지워도 하나는
   * 반드시 빨간불이 된다.
   */
  it('등록이 열려 있으면 아니다 — 테이블이 하나여도', () => {
    expect(isFinalTable({ isRegistrationOpen: true, tableCount: 1 })).toBe(false);
  });

  it('테이블이 둘 이상이면 아니다 — 마감됐어도', () => {
    expect(isFinalTable({ isRegistrationOpen: false, tableCount: 2 })).toBe(false);
  });

  /**
   * 사람이 적어 **처음부터 테이블 하나로 연 대회**도 마감되면 파이널
   * 테이블이다. 위의 "등록이 열려 있으면 아니다"와 짝이 되어, 판정이
   * 테이블 수가 줄어든 이력이 아니라 지금 상태만 본다는 것을 못 박는다.
   */
  it('테이블이 줄어든 이력을 묻지 않는다', () => {
    expect(isFinalTable({ isRegistrationOpen: false, tableCount: 1 })).toBe(true);
  });

  /**
   * 테이블이 0인 대회는 딜러가 조작할 자리 자체가 없다. 그래도 `true`를
   * 돌려주면 "파이널 테이블이라 막았다"는 안내가 나가는데, 실제 원인은
   * 테이블이 없는 것이라 딜러가 엉뚱한 곳을 본다.
   */
  it('테이블이 0이면 아니다', () => {
    expect(isFinalTable({ isRegistrationOpen: false, tableCount: 0 })).toBe(false);
  });
});
