import { FinishPreviewSchema } from './finish-preview';

const VALID = {
  totalBuyinAmount: 210_000,
  rakePercent: 10,
  rakeAmount: 21_000,
  prizePool: 189_000,
  paidPrize: 56_700,
  remainingPrize: 132_300,
  complete: { canRun: false, reason: '상금 정산이 끝나지 않았습니다. 132300 남았습니다.' },
  chop: {
    canRun: true,
    reason: null,
    rows: [
      { userId: 'a', nickname: '김민준', place: 1, currentStack: 157_500, amount: 99_225 },
      { userId: 'b', nickname: '이서연', place: 2, currentStack: 52_500, amount: 33_075 },
    ],
  },
  abort: {
    canRun: true,
    reason: null,
    groups: [
      { kind: 'LIVE' as const, count: 2, amount: 21_000 },
      { kind: 'FINISHED' as const, count: 14, amount: 73_500 },
      { kind: 'PRIZED' as const, count: 1, amount: 0 },
    ],
    storeAmount: 58_800,
    scaled: false,
  },
};

describe('FinishPreviewSchema', () => {
  it('세 조작의 미리보기를 한 봉투로 받는다', () => {
    const parsed = FinishPreviewSchema.parse(VALID);
    expect(parsed.chop.rows[0].amount).toBe(99_225);
    expect(parsed.abort.groups[1].kind).toBe('FINISHED');
  });

  /**
   * 아웃바운드라 스키마에 없는 키는 조용히 사라진다. 미리보기는 **참가자
   * 개인의 장부를 훑는 조회**라, 스키마를 늘리지 않는 한 포인트 잔액 같은
   * 것이 화면으로 새 나가지 않는다.
   */
  it('스키마에 없는 키를 지운다', () => {
    const parsed = FinishPreviewSchema.parse({
      ...VALID,
      chop: {
        ...VALID.chop,
        rows: [{ ...VALID.chop.rows[0], points: 9_999_999 }],
      },
    });
    expect(parsed.chop.rows[0]).not.toHaveProperty('points');
  });

  // 닉네임은 없을 수 있다(`User.nickname`이 nullable). 화면이 userId로 대신 그린다.
  it('닉네임 없음을 통과시킨다', () => {
    const parsed = FinishPreviewSchema.parse({
      ...VALID,
      chop: { ...VALID.chop, rows: [{ ...VALID.chop.rows[0], nickname: null }] },
    });
    expect(parsed.chop.rows[0].nickname).toBeNull();
  });

  it('모르는 무리 이름은 거절한다', () => {
    const parsed = FinishPreviewSchema.safeParse({
      ...VALID,
      abort: { ...VALID.abort, groups: [{ kind: 'STORE', count: 1, amount: 1 }] },
    });
    expect(parsed.success).toBe(false);
  });
});
