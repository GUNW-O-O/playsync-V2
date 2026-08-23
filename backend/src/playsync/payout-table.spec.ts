import {
  DEFAULT_PAYOUT_TABLE,
  entryCountOf,
  parsePayoutTable,
  payoutsFor,
  payoutsForRaw,
} from './payout-table';

/**
 * 참가 규모에 따라 상금권 인원이 늘어나는 규칙.
 *
 * **분모는 사람 수가 아니라 엔트리 수다.** 홀덤 대회의 구조표가 그렇게 적힌다
 * ("X entries → Y places paid"). 리바인 대회에서 50명이 두 번씩 사면 엔트리는
 * 100개이고 프라이즈풀도 100 바이인이다 — 그것을 50명 기준 상금권으로 나누면
 * 상금 하나하나가 바이인 대비 터무니없이 커진다.
 *
 * 코드 쪽 근거도 같다. 프라이즈풀이 `엔트리 × entryFee`인데 상금권 인원을 사람
 * 수에서 뽑으면 **분모가 둘이 된다.**
 */
describe('entryCountOf', () => {
  it('걷은 총액을 참가비로 나눈 것이 엔트리 수다', () => {
    expect(entryCountOf(30_000, 10_000)).toBe(3);
  });

  /** 리바인은 사람을 안 늘리고 엔트리를 늘린다. `totalPlayers`로는 못 세는 값이다. */
  it('리바인도 엔트리로 센다', () => {
    // 두 명이 각각 한 번씩 리바인했다. 사람은 둘, 엔트리는 넷.
    expect(entryCountOf(40_000, 10_000)).toBe(4);
  });

  it('아무도 안 냈으면 0이다', () => {
    expect(entryCountOf(0, 10_000)).toBe(0);
  });

  /**
   * 참가비 0은 DTO가 막지만(`ENTRY_FEE_MIN`) 여기서도 죽지 않아야 한다.
   * 0으로 나누면 `Infinity`가 되고, 그 값이 구간 조회에 들어가면 표의 마지막
   * 구간이 조용히 선택된다.
   */
  it('참가비가 0이면 0이다 — 나누지 않는다', () => {
    expect(entryCountOf(30_000, 0)).toBe(0);
  });
});

describe('payoutsFor', () => {
  const TABLE = parsePayoutTable([
    { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
    { minEntries: 10, payouts: [{ place: 1, percent: 60 }, { place: 2, percent: 40 }] },
    {
      minEntries: 20,
      payouts: [
        { place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 },
      ],
    },
  ]);

  it('엔트리 수가 든 구간의 분배율을 고른다', () => {
    expect(payoutsFor(14, TABLE)).toEqual([
      { place: 1, percent: 60 }, { place: 2, percent: 40 },
    ]);
  });

  /** 경계는 **포함**이다. 「10명 이상」이라고 적힌 구간은 10에서 시작한다. */
  it('경계 값은 그 구간에 든다', () => {
    expect(payoutsFor(10, TABLE)).toHaveLength(2);
  });

  it('경계 바로 아래는 앞 구간이다', () => {
    expect(payoutsFor(9, TABLE)).toHaveLength(1);
  });

  it('표의 마지막 구간보다 크면 마지막 구간이다', () => {
    expect(payoutsFor(9999, TABLE)).toHaveLength(3);
  });

  /**
   * **아무도 안 냈을 때도 답이 있어야 한다.** 대회를 만든 직후가 그 상태고,
   * 전광판이 그때 이미 예상 상금권을 그린다.
   */
  it('엔트리가 0이어도 첫 구간을 돌려준다', () => {
    expect(payoutsFor(0, TABLE)).toHaveLength(1);
  });
});

describe('parsePayoutTable', () => {
  it('첫 구간은 0에서 시작해야 한다', () => {
    // 0에서 시작하지 않으면 엔트리 0인 대회가 고를 구간이 없다.
    expect(() => parsePayoutTable([
      { minEntries: 2, payouts: [{ place: 1, percent: 100 }] },
    ])).toThrow('0');
  });

  it('구간은 오름차순이어야 한다', () => {
    expect(() => parsePayoutTable([
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 30, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 10, payouts: [{ place: 1, percent: 100 }] },
    ])).toThrow('오름차순');
  });

  it('같은 경계가 두 번 나오면 거절한다', () => {
    expect(() => parsePayoutTable([
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
    ])).toThrow('오름차순');
  });

  it('빈 표는 거절한다', () => {
    expect(() => parsePayoutTable([])).toThrow();
  });

  /**
   * **구간마다 분배율 검증을 다시 태운다**(`parsePayouts`). 표 하나에 구간이
   * 여덟이면 잘못된 구간이 여덟 중 하나일 수 있고, 그 구간은 **그 규모의
   * 대회가 열릴 때까지 안 드러난다.**
   */
  it('구간 하나라도 합이 100이 아니면 거절한다', () => {
    expect(() => parsePayoutTable([
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 10, payouts: [{ place: 1, percent: 60 }, { place: 2, percent: 30 }] },
    ])).toThrow('100');
  });

  it('구간 하나라도 등수가 끊기면 거절한다', () => {
    expect(() => parsePayoutTable([
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 10, payouts: [{ place: 1, percent: 60 }, { place: 3, percent: 40 }] },
    ])).toThrow('연속');
  });

  it('구간 순서가 뒤섞여 들어와도 정렬해서 돌려준다', () => {
    // 오름차순 검사는 정렬 **전** 입력을 본다. 그래야 상점이 실수한 것을
    // 조용히 고쳐 주지 않는다 — 위 「오름차순이어야 한다」와 짝이다.
    const table = parsePayoutTable([
      { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
      { minEntries: 10, payouts: [{ place: 1, percent: 100 }] },
    ]);
    expect(table.map(t => t.minEntries)).toEqual([0, 10]);
  });
});

describe('DEFAULT_PAYOUT_TABLE', () => {
  it('표 자체가 규칙을 통과한다', () => {
    expect(() => parsePayoutTable(DEFAULT_PAYOUT_TABLE)).not.toThrow();
  });

  /**
   * **상위 10~15%가 상금권**이라는 것이 홀덤 관례다. WSOP가 15%,
   * 라이브 룸이 대개 10~12%다. 소규모일수록 비율이 커진다 — 5명 대회에서
   * 10%는 0명이 되기 때문이다.
   */
  it('규모가 커지면 상금권 인원도 는다', () => {
    const counts = [1, 8, 12, 20, 30, 40, 60, 100]
      .map(n => payoutsFor(n, DEFAULT_PAYOUT_TABLE).length);

    // 단조 증가. 어느 구간에서도 줄지 않는다.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(`${counts[0]}명 → ${counts[counts.length - 1]}명`).toBe('1명 → 9명');
  });

  /**
   * **비율은 규모가 커질수록 작아진다.** 10명 대회의 3자리는 30%지만 그것이
   * 정상이다 — 5명 대회에서 10%는 0명이 되므로 소규모는 비율을 키워야 한다.
   * 관례의 10~15%는 중대형 필드의 값이다.
   */
  it('규모가 커질수록 상금권 비율은 작아진다', () => {
    const ratios = [10, 16, 25, 36, 50, 70, 100]
      .map(n => payoutsFor(n, DEFAULT_PAYOUT_TABLE).length / n);

    // 단조 감소. 어느 구간에서도 커지지 않는다.
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  });

  /**
   * **상금권은 파이널 테이블에서 멈춘다.** 홀덤펍 시리즈의 흔한 규칙이고,
   * 이 시스템이 그리는 화면과도 맞는다 — 테이블 하나가 곧 마지막 화면이다.
   * 표를 더 늘리려면 상점이 자기 표를 주면 된다.
   */
  it('상금권은 아홉을 넘지 않는다 — 파이널 테이블까지다', () => {
    const most = payoutsFor(100_000, DEFAULT_PAYOUT_TABLE).length;

    expect(`최대 ${most}명`).toBe('최대 9명');
  });

  /** 필드가 커질수록 곡선이 완만해진다 — 우승 몫이 줄고 넓게 퍼진다. */
  it('규모가 커질수록 우승 몫이 줄어든다', () => {
    const winner = (n: number) => payoutsFor(n, DEFAULT_PAYOUT_TABLE)[0].percent;

    expect(winner(8)).toBeGreaterThan(winner(100));
  });
});

/**
 * 지급 경로의 관대한 조회.
 *
 * **소리내어 막는 자리는 시작 게이트다.** 여기서 던지면 핸드 정산 한가운데서
 * 트랜잭션이 통째로 되돌아가고, 그 시점에 표를 고칠 방법이 없다.
 */
describe('payoutsForRaw', () => {
  it('표가 있으면 구간을 고른다', () => {
    const raw = [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }];

    expect(payoutsForRaw(3, raw)).toHaveLength(1);
  });

  it('표가 비어 있으면 상금이 없다 — 던지지 않는다', () => {
    expect(payoutsForRaw(3, [])).toEqual([]);
  });

  it('표가 아예 없어도 던지지 않는다', () => {
    expect(payoutsForRaw(3, null)).toEqual([]);
  });

  /** 컬럼이 Json이라 배열이 아닌 값이 들어 있을 수 있다. */
  it('배열이 아니면 상금이 없다', () => {
    expect(payoutsForRaw(3, { minEntries: 0 })).toEqual([]);
  });
});
