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
    blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
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
      blindField: { ...VALID.blindField, isBreak: true, blindStructure: [{ lv: 99, sb: 100, ante: false, duration: 10 }] },
    });
    expect(parsed.blindField.isBreak).toBe(true);
    expect(parsed.blindField.blindStructure[0].lv).toBe(99);
  });
});
