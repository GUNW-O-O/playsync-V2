import { FullTournamentInfoSchema } from './dashboard';

const VALID = {
  dashboard: {
    isRegistrationOpen: true, totalPlayer: 20, activePlayer: 7,
    totalBuyinAmount: 350000, rakePercent: 0, rebuyUntil: 0, avgStack: 50000,
    tournamentName: '데모 토너먼트', entryFee: 50000, startStack: 30000,
    entryCount: 7, itmCount: 3, prizePool: 350000,
    prizes: [{ place: 1, percent: 50, amount: 175000 }],
  },
  blindField: {
    isBreak: false, startedAt: 0, currentBlindLv: 0,
    nextLevelAt: 1000, serverTime: 0,
    blindStructure: [{ lv: 1, sb: 100, ante: 0, duration: 10 }],
  },
};

describe('FullTournamentInfoSchema', () => {
  it('아웃바운드는 스키마에 없는 키를 조용히 지운다', () => {
    const parsed = FullTournamentInfoSchema.parse({
      ...VALID,
      dashboard: { ...VALID.dashboard, dealerOtpHash: '새면-안-되는-값' },
    });
    expect(parsed.dashboard).not.toHaveProperty('dealerOtpHash');
  });

  it('휴식 레벨을 그대로 통과시킨다', () => {
    const parsed = FullTournamentInfoSchema.parse({
      ...VALID,
      blindField: { ...VALID.blindField, isBreak: true, blindStructure: [{ lv: 99, sb: 100, ante: 0, duration: 10 }] },
    });
    expect(parsed.blindField.isBreak).toBe(true);
    expect(parsed.blindField.blindStructure[0].lv).toBe(99);
  });

  /**
   * **앤티는 금액이다.** 전광판이 「앤티 있음」만 알면 딜러도 참가자도 얼마를
   * 내는지 화면으로 못 본다. `boolean`을 그대로 두고 금액을 옆에 더하면 같은
   * 사실이 두 벌이 되므로, 이 자리 하나가 금액을 든다 — 0이면 없다는 뜻이고
   * `TableStateSchema.ante`와 모양이 같다(T58).
   *
   * 계산은 `deriveAnteAmount` 한 곳이다. 프론트가 `sb / 5`를 다시 적으면
   * 백엔드가 식을 바꿀 때 조용히 어긋난다.
   */
  it('앤티는 금액으로 온다 — boolean은 거절한다', () => {
    const parsed = FullTournamentInfoSchema.parse({
      ...VALID,
      blindField: {
        ...VALID.blindField,
        blindStructure: [{ lv: 1, sb: 600, ante: 120, duration: 10 }],
      },
    });
    expect(parsed.blindField.blindStructure[0].ante).toBe(120);

    const rejected = FullTournamentInfoSchema.safeParse({
      ...VALID,
      blindField: {
        ...VALID.blindField,
        blindStructure: [{ lv: 1, sb: 600, ante: true, duration: 10 }],
      },
    });
    expect(rejected.success).toBe(false);
  });
});
