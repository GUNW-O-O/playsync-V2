import { buildTournamentMeta, TournamentMetaSource } from './tournament-meta';

/**
 * `buildTournamentMeta`는 `initializeGame`에서 그대로 뽑아낸 것이다. 로직은
 * 바꾸지 않았고 기준점(`blindBaseAt`)만 인자로 받게 했다 — 그래서 여기서
 * 검증할 것은 두 가지뿐이다. 기준점을 옮기면 레벨이 그만큼 움직이는지, 그리고
 * 옮긴 기준점이 휴식 레벨에 걸리면 `isBreak`가 정직하게 참이 되는지.
 *
 * 뒤쪽이 진짜 회귀 대상이다 — 지금 `initializeGame`은 `isBreak: false`를
 * 하드코딩한다. 시작 시점엔 항상 레벨 0이라 맞지만, 복구는 중간 레벨에서
 * 시작하므로 하드코딩을 그대로 옮기면 복구 직후의 휴식 상태를 놓친다.
 */
describe('buildTournamentMeta', () => {
  const baseGame = (overrides: Partial<TournamentMetaSource> = {}): TournamentMetaSource => ({
    name: '테스트 대회',
    entryFee: 0,
    startStack: 0,
    isRegistrationOpen: true,
    totalPlayers: 0,
    activePlayers: 0,
    totalBuyinAmount: 0,
    rakePercent: 0,
    rebuyUntil: 0,
    avgStack: 0,
    payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
    blindStructure: { structure: [] },
    ...overrides,
  });

  /**
   * T125 ①. 휴식은 레벨이 아니라 그 앞 레벨의 연장이다(T63, `currentRegistrationLevel`).
   * 이 함수만 그 판정을 안 거쳐 휴식의 `lv`(99)를 마감 레벨과 그대로 비교했다 —
   * 휴식 중에 메타를 다시 세우면(복구) 등록이 닫힌 것으로 쓰이고, 그 값은 단조라
   * 다시 열리지 않는다.
   */
  describe('휴식 중의 등록', () => {
    const structure = [
      { lv: 1, sb: 100, ante: false, duration: 10 },
      { lv: 99, sb: 0, ante: false, duration: 10 },
      { lv: 2, sb: 200, ante: false, duration: 10 },
    ];
    const now = Date.now();

    it('마감 레벨 전의 휴식이면 열려 있다', () => {
      const game = baseGame({ blindStructure: { structure }, rebuyUntil: 2 });
      // 15분 전에 시작 → 휴식(인덱스 1). 직전 실제 레벨은 1이고 마감은 2다.
      const { dashboard, blindField } = buildTournamentMeta(game, now - 15 * 60 * 1000);

      expect(`휴식 ${blindField.isBreak} 등록 ${dashboard.isRegistrationOpen}`).toBe('휴식 true 등록 true');
    });

    it('마감 레벨 뒤의 휴식이면 닫혀 있다 (반대 입력)', () => {
      const game = baseGame({ blindStructure: { structure }, rebuyUntil: 1 });
      const { dashboard, blindField } = buildTournamentMeta(game, now - 15 * 60 * 1000);

      expect(`휴식 ${blindField.isBreak} 등록 ${dashboard.isRegistrationOpen}`).toBe('휴식 true 등록 false');
    });
  });

  it('기준점을 미루면 레벨이 되돌아간다', () => {
    const structure = [
      { lv: 1, sb: 100, ante: false, duration: 10 },
      { lv: 2, sb: 200, ante: false, duration: 10 },
    ];
    const game = baseGame({ blindStructure: { structure } });

    // 25분 전에 시작 → 레벨 2 (인덱스 1)
    const now = Date.now();
    const running = buildTournamentMeta(game, now - 25 * 60 * 1000);
    expect(`레벨 ${running.blindField.currentBlindLv}`).toBe('레벨 1');

    // 20분을 정지했다면 기준점이 20분 뒤로 밀린다 → 레벨 1 (인덱스 0)
    const paused = buildTournamentMeta(game, now - 25 * 60 * 1000 + 20 * 60 * 1000);
    expect(`레벨 ${paused.blindField.currentBlindLv}`).toBe('레벨 0');
  });

  it('중간 레벨이 휴식이면 isBreak가 참이다', () => {
    // lv 99가 휴식이다(shared/util/util.ts). 하드코딩된 false였다면 이
    // 테스트가 빨개진다 — 25분 경과 시점은 딱 그 휴식 레벨 한가운데다.
    const structure = [
      { lv: 1, sb: 100, ante: false, duration: 20 },
      { lv: 99, sb: 100, ante: false, duration: 10 },
      { lv: 2, sb: 200, ante: false, duration: 20 },
    ];
    const game = baseGame({ blindStructure: { structure } });

    const now = Date.now();
    const { blindField } = buildTournamentMeta(game, now - 25 * 60 * 1000);

    expect(`레벨 ${blindField.currentBlindLv} / 휴식 ${blindField.isBreak}`)
      .toBe('레벨 1 / 휴식 true');
  });

  it('blindBaseAt을 BlindField.startedAt에 그대로 싣는다', () => {
    // Tournament.startedAt과 뜻이 다른 값이라(T31 결정 1), 여기서 다시
    // 계산하거나 반올림하지 않는다.
    const structure = [{ lv: 1, sb: 100, ante: false, duration: 20 }];
    const game = baseGame({ blindStructure: { structure } });
    const baseAt = Date.now() - 5 * 60 * 1000;

    const { blindField } = buildTournamentMeta(game, baseAt);

    expect(blindField.startedAt).toBe(baseAt);
  });
});
