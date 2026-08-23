import { PlayerStatus } from '@prisma/client';
import {
  SettlementParticipant,
  calculateAbortSettlement,
  calculateChop,
  splitByRatio,
} from './settlement';

/**
 * 중단 정산의 계산부.
 *
 * **순수 함수로 떼어 놓는 이유는 ③(ICM 찹)이 같은 자리를 쓰기 때문이다.**
 * 둘 다 "대회를 끝내면서 남은 돈을 여럿에게 나눈다"이고, 다른 것은 **무슨
 * 비율로 나누는가**뿐이다 — 중단은 각자가 낸 돈, 찹은 각자의 칩.
 */

function p(
  userId: string,
  status: PlayerStatus,
  opts: { buyInCount?: number; prizeAmount?: number } = {},
): SettlementParticipant {
  return {
    userId,
    status,
    buyInCount: opts.buyInCount ?? 1,
    prizeAmount: opts.prizeAmount ?? 0,
  };
}

const FEE = 1000;

describe('splitByRatio', () => {
  it('가중치 비율대로 나눈다', () => {
    const split = splitByRatio(1000, [
      { userId: 'a', weight: 3 },
      { userId: 'b', weight: 1 },
    ]);

    expect(split).toEqual([
      { userId: 'a', amount: 750 },
      { userId: 'b', amount: 250 },
    ]);
  });

  /**
   * **나머지 한 단위가 사라지면 안 된다.** 각자 내림하면 그 원이 어디에도
   * 속하지 않고 없어지고, 「나눈 합 == 나눌 돈」이 깨진다 — `calculatePrizes`가
   * 1위에 나머지를 몰아 준 것과 같은 이유다(T15의 사이드팟 증발).
   */
  it('나머지까지 나눠 합이 정확히 맞는다', () => {
    const split = splitByRatio(1000, [
      { userId: 'a', weight: 1 },
      { userId: 'b', weight: 1 },
      { userId: 'c', weight: 1 },
    ]);

    expect(split.reduce((s, x) => s + x.amount, 0)).toBe(1000);
  });

  /** 나머지는 **소수부가 큰 쪽**이 먼저 가져간다. 같으면 입력 순서다. */
  it('나머지는 소수부가 큰 쪽이 가져간다', () => {
    const split = splitByRatio(10, [
      { userId: 'a', weight: 1 },
      { userId: 'b', weight: 2 },
    ]);

    // 3.33 / 6.66 → 3 / 6, 남은 1은 소수부가 큰 b에게.
    expect(split).toEqual([
      { userId: 'a', amount: 3 },
      { userId: 'b', amount: 7 },
    ]);
  });

  it('가중치가 0뿐이면 아무에게도 주지 않는다', () => {
    const split = splitByRatio(1000, [
      { userId: 'a', weight: 0 },
      { userId: 'b', weight: 0 },
    ]);

    expect(split).toEqual([
      { userId: 'a', amount: 0 },
      { userId: 'b', amount: 0 },
    ]);
  });
});

describe('calculateAbortSettlement', () => {
  /**
   * **살아 있는 사람은 낸 돈을 다 돌려받는다.** 중단은 대회사의 사정이라
   * 아직 지고 있지 않은 사람에게 손해를 남길 근거가 없다.
   */
  it('진행 중인 사람은 100%를 돌려받는다', () => {
    const s = calculateAbortSettlement([p('a', PlayerStatus.PLAYING)], FEE, 1000);

    expect(s.refunds).toEqual([{ userId: 'a', amount: 1000 }]);
  });

  /** 좌석만 뗀 사람(T29)은 칩을 들고 있다 — 여전히 대회에 있는 사람이다. */
  it('좌석이 해제된 사람도 100%다', () => {
    const s = calculateAbortSettlement([p('a', PlayerStatus.RELEASED)], FEE, 1000);

    expect(s.refunds).toEqual([{ userId: 'a', amount: 1000 }]);
  });

  /** 결제만 하고 안 온 사람(노쇼)도 진 것이 아니다. */
  it('한 번도 안 앉은 사람도 100%다', () => {
    const s = calculateAbortSettlement([p('a', PlayerStatus.WAITING)], FEE, 1000);

    expect(s.refunds).toEqual([{ userId: 'a', amount: 1000 }]);
  });

  /**
   * **탈락한 사람은 절반이다.** 중단이 대회사의 사정이라 나간 사람에게도
   * 얼마간 주는 것이 맞지만, 이미 진 사람과 아직 지지 않은 사람을 같이 볼
   * 수는 없다. 등록 마감 전후를 가리지 않는다.
   */
  it('탈락한 사람은 50%다', () => {
    const s = calculateAbortSettlement([p('a', PlayerStatus.ELIMINATED)], FEE, 1000);

    expect(s.refunds).toEqual([{ userId: 'a', amount: 500 }]);
  });

  /**
   * **분모는 참가 횟수가 아니라 실제 낸 총액이다.** 리바인한 사람은 두 번
   * 냈으므로 두 번 낸 것을 기준으로 돌려받는다.
   */
  it('리바인한 사람은 낸 총액 기준이다', () => {
    const s = calculateAbortSettlement(
      [p('a', PlayerStatus.PLAYING, { buyInCount: 3 })], FEE, 3000,
    );

    expect(s.refunds).toEqual([{ userId: 'a', amount: 3000 }]);
  });

  /**
   * **이미 받은 상금은 환불에서 뺀다.** 상금은 이 대회의 돈에서 나갔으므로,
   * 빼지 않으면 같은 사람이 같은 풀에서 두 번 가져간다.
   */
  it('이미 받은 상금을 환불에서 뺀다', () => {
    const s = calculateAbortSettlement(
      [p('a', PlayerStatus.AWARDED, { prizeAmount: 200 })], FEE, 1000,
    );

    // 탈락 기준 500에서 이미 받은 200을 뺀다.
    expect(s.refunds).toEqual([{ userId: 'a', amount: 300 }]);
  });

  /** **회수하지 않는다.** 이미 준 돈을 도로 가져가는 경로는 만들지 않는다. */
  it('상금이 환불액보다 많으면 0이고 회수하지 않는다', () => {
    const s = calculateAbortSettlement(
      [p('a', PlayerStatus.AWARDED, { prizeAmount: 5000 })], FEE, 1000,
    );

    expect(s.refunds).toEqual([{ userId: 'a', amount: 0 }]);
  });

  /**
   * **남은 돈은 상점이 갖는다.** 중단은 대회사의 사정이지만 걷은 돈이 다
   * 나가지는 않으므로, 갈 곳을 정해 두지 않으면 그 돈이 장부에서 사라진다.
   */
  it('남은 돈은 상점 몫이다', () => {
    const s = calculateAbortSettlement(
      [p('a', PlayerStatus.ELIMINATED), p('b', PlayerStatus.ELIMINATED)], FEE, 2000,
    );

    expect(`환불 ${s.refunds.map(r => r.amount).join('+')} / 상점 ${s.storeAmount}`)
      .toBe('환불 500+500 / 상점 1000');
  });

  /**
   * **보존 등식이 이 계산의 전부다.**
   *
   * `걷은 돈 == 이미 나간 상금 + 환불 + 상점 몫`. 어긋나면 그 대회의 회계가
   * 영영 안 맞고, 그건 `completeSession`이 막으려던 상태와 같다.
   */
  it('걷은 돈 == 상금 + 환불 + 상점 몫', () => {
    const participants = [
      p('a', PlayerStatus.PLAYING, { buyInCount: 2 }),
      p('b', PlayerStatus.ELIMINATED),
      p('c', PlayerStatus.AWARDED, { prizeAmount: 700 }),
    ];
    const pool = 4 * FEE;

    const s = calculateAbortSettlement(participants, FEE, pool);

    const paidPrizes = participants.reduce((sum, x) => sum + x.prizeAmount, 0);
    const refunded = s.refunds.reduce((sum, r) => sum + r.amount, 0);
    expect(paidPrizes + refunded + s.storeAmount).toBe(pool);
  });

  /**
   * **돈이 모자라면 비율대로 깎는다.**
   *
   * 상금이 이미 크게 나간 뒤에 중단하면 남은 돈이 환불 희망액보다 적을 수
   * 있다. 그때 거절하면 **닫을 수 없는 대회**가 남는데, 이 리포가 그것을
   * 결함으로 다뤄 왔다(파이널 테이블 킥, T77). 그래서 낼 수 있는 만큼만
   * 나가고 대회는 반드시 닫힌다.
   */
  it('남은 돈이 모자라면 비율대로 깎는다', () => {
    const participants = [
      p('a', PlayerStatus.PLAYING),
      p('b', PlayerStatus.PLAYING),
      p('c', PlayerStatus.AWARDED, { prizeAmount: 1800 }),
    ];
    // 셋이 3000을 냈고 1800이 이미 상금으로 나갔다. 남은 것은 1200인데
    // 살아 있는 둘이 1000씩 원한다.
    const s = calculateAbortSettlement(participants, FEE, 3000);

    expect(`${s.refunds.map(r => `${r.userId}:${r.amount}`).join(' ')} / 상점 ${s.storeAmount}`)
      .toBe('a:600 b:600 c:0 / 상점 0');
  });

  /** 깎였을 때도 보존 등식은 그대로다. */
  it('깎였을 때도 합이 정확히 맞는다', () => {
    const participants = [
      p('a', PlayerStatus.PLAYING),
      p('b', PlayerStatus.PLAYING),
      p('c', PlayerStatus.PLAYING),
      p('d', PlayerStatus.AWARDED, { prizeAmount: 3999 }),
    ];
    const pool = 4 * FEE;

    const s = calculateAbortSettlement(participants, FEE, pool);

    const refunded = s.refunds.reduce((sum, r) => sum + r.amount, 0);
    expect(`환불 ${refunded} / 상점 ${s.storeAmount}`).toBe('환불 1 / 상점 0');
  });

  /** 아무도 참가하지 않은 대회. 걷은 돈이 없으니 상점 몫도 없다. */
  it('참가자가 없으면 아무 일도 없다', () => {
    const s = calculateAbortSettlement([], FEE, 0);

    expect(`환불 ${s.refunds.length}건 / 상점 ${s.storeAmount}`).toBe('환불 0건 / 상점 0');
  });
});

/**
 * ICM 찹 — 남은 사람들이 딜로 끝낸다.
 *
 * **파이널 테이블에서 지쳤을 때 하는 것이다.** 남은 상금을 각자의 칩 비율로
 * 나누고 대회를 끝낸다. 중단 정산과 **같은 자리**(`splitByRatio`)를 쓴다 —
 * 둘 다 "대회를 끝내면서 남은 돈을 여럿에게 나눈다"이고 다른 것은 무슨 비율로
 * 나누는가뿐이다.
 */
describe('calculateChop', () => {
  function chip(userId: string, currentStack: number) {
    return { userId, currentStack };
  }

  it('칩 비율대로 남은 상금을 나눈다', () => {
    const awards = calculateChop(
      [chip('a', 30_000), chip('b', 10_000)], 4000,
    );

    expect(awards.map(a => `${a.userId} ${a.amount}`).join(' / ')).toBe('a 3000 / b 1000');
  });

  /** **등수는 칩이 정한다.** 많이 든 사람이 1위다 — 딜에서도 기록은 남는다. */
  it('칩이 많은 사람이 높은 등수다', () => {
    const awards = calculateChop(
      [chip('small', 1000), chip('big', 9000)], 10_000,
    );

    expect(awards.map(a => `${a.place}위 ${a.userId}`).join(' / ')).toBe('1위 big / 2위 small');
  });

  /**
   * **나눈 합이 정확히 남은 상금과 같다.** 어긋나면 `completeSession`의
   * 게이트가 영영 안 열려 대회가 닫히지 않는다.
   */
  it('나눈 합이 남은 상금과 정확히 같다', () => {
    const awards = calculateChop(
      [chip('a', 1), chip('b', 1), chip('c', 1)], 1000,
    );

    expect(awards.reduce((s, a) => s + a.amount, 0)).toBe(1000);
  });

  /** 칩이 같으면 입력 순서가 등수를 가른다. 금액은 어차피 같다. */
  it('칩이 같으면 금액도 같다', () => {
    const awards = calculateChop([chip('a', 5000), chip('b', 5000)], 4000);

    expect(awards.map(a => a.amount)).toEqual([2000, 2000]);
  });

  /** 남은 상금이 없으면 아무도 못 받지만 등수는 남는다 — 대회는 닫혀야 한다. */
  it('남은 상금이 0이면 전원 0원이고 등수는 매긴다', () => {
    const awards = calculateChop([chip('a', 5000), chip('b', 3000)], 0);

    expect(awards.map(a => `${a.place}위 ${a.amount}원`).join(' / ')).toBe('1위 0원 / 2위 0원');
  });
});
