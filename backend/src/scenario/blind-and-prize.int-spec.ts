import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * 대회가 끝까지 가는 축: 블라인드가 오르고, 사람이 줄고, 상금이 나간다.
 *
 * 앞선 시나리오들은 **핸드 하나**를 본다. 여기는 그 위 층위다 — 여러 핸드에
 * 걸쳐 대회 자체가 진행되는 축이고, MVP가 "완전히 돌아간다"고 말하려면
 * 이 축이 끝까지 닿아야 한다.
 *
 * 두 가지가 얽혀 있다.
 *
 * 1. **블라인드는 시각으로 계산된다.** 저장된 레벨이 진실이 아니라 `startedAt`과
 *    현재 시각이 진실이다. 그래서 서버가 재기동해도 레벨이 되돌아가지 않고,
 *    폴링이 밀리면 한 번에 여러 칸을 건너뛴다. 그 계산이 실제 핸드의 SB/BB에
 *    닿는지가 검증 대상이다 — 전광판만 오르고 테이블은 안 오르면 아무 의미가 없다.
 *
 * 2. **상금은 걷은 돈에서 나온다.** 예전에는 우승 3000, 인 더 머니 1000이
 *    상수였다(T18). 참가비가 얼마든 같았다. 리바인이 들어오면 풀이 커지고,
 *    그 순간 전광판 숫자도 같이 커져야 한다 — 참가자가 리바인할 이유가
 *    화면에 보여야 하기 때문이다.
 */
describe('시나리오 — 블라인드 상승과 상금 지급', () => {
  let h: Harness;
  const PLAYERS = ['champ', 'second', 'third'];
  const MINUTE = 60 * 1000;

  // 레벨마다 10분. 시나리오는 시각을 앞당기는 대신 startedAt을 뒤로 민다.
  const STRUCTURE = [
    { lv: 1, sb: 100, ante: false, duration: 10 },
    { lv: 2, sb: 200, ante: false, duration: 10 },
    { lv: 3, sb: 400, ante: true, duration: 10 },
  ];

  const PAYOUTS = [
    { place: 1, percent: 60 },
    { place: 2, percent: 40 },
  ];

  const pool = SCENARIO.entryFee * PLAYERS.length;
  const chips = SCENARIO.startStack * PLAYERS.length;

  /** 대회가 시작한 지 `minutes`분 지난 것으로 만든다. */
  async function elapse(minutes: number) {
    const blind = (await h.redisService.getTournamentBlind(h.tournamentId))!;
    await h.redisService.setTournamentBlind(h.tournamentId, {
      ...blind,
      startedAt: Date.now() - minutes * MINUTE,
      // nextLevelAt을 지난 시각으로 둬야 재계산 경로를 탄다. 이 값이 미래면
      // 최적화 분기에서 저장된 레벨을 그대로 돌려준다.
      nextLevelAt: Date.now() - 1,
    });
  }

  beforeAll(async () => {
    h = await setupTournament(PLAYERS, {
      blindStructure: STRUCTURE,
      prizePayouts: PAYOUTS,
      // 레벨 2까지 리바인 가능. 그 뒤로는 스택이 0이면 곧바로 탈락이다.
      rebuyUntil: 2,
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 대회는 레벨 1에서 시작한다', async () => {
    const blind = await h.redisService.getTournamentBlind(h.tournamentId);
    expect(blind!.currentBlindLv).toBe(0);
    expect(blind!.blindStructure[blind!.currentBlindLv].sb).toBe(100);
  });

  it('2. 첫 핸드의 블라인드는 레벨 1의 값이다', async () => {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '레벨1 프리플랍', chips);
    expect(state.smallBlind).toBe(100);
    expect(state.ante).toBe(false);
  });

  it('3. 시간이 지나면 레벨이 오른다', async () => {
    await elapse(12); // 레벨 1(10분)을 넘겼다

    const blind = await h.redisService.checkAndSyncBlindLevel(h.tournamentId);
    expect(blind!.currentBlindLv).toBe(1);
    expect(blind!.blindStructure[blind!.currentBlindLv].sb).toBe(200);
  });

  it('4. 오른 블라인드가 다음 핸드에 실제로 적용된다', async () => {
    // **여기가 진짜 이음매다.** 전광판만 오르고 테이블이 안 오르면 대회가
    // 진행되지 않는다 — 스택이 녹지 않아 아무도 탈락하지 않는다.
    await finishHand();

    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '레벨2 프리플랍', chips);
    expect(state.smallBlind).toBe(200);
  });

  it('5. 폴링이 밀려 여러 레벨이 지나도 한 번에 따라잡는다', async () => {
    // 레벨은 저장된 값이 아니라 startedAt에서 매번 다시 계산된다. 서버가
    // 재기동했거나 아무도 조회하지 않은 구간이 있어도 되돌아가지 않는다.
    await elapse(25); // 레벨 1·2를 지나 레벨 3

    const blind = await h.redisService.checkAndSyncBlindLevel(h.tournamentId);
    expect(blind!.currentBlindLv).toBe(2);
    expect(blind!.blindStructure[blind!.currentBlindLv].ante).toBe(true);

    await finishHand();
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '레벨3 프리플랍', chips);
    expect(state.smallBlind).toBe(400);
    expect(state.ante).toBe(true);
  });

  it('6. 리바인 마감 레벨을 지나면 등록이 자동으로 닫힌다', async () => {
    // 마감은 사람이 누르는 것이 아니라 레벨이 지나면 닫힌다. 레벨은 한 번에
    // 여러 칸 뛸 수 있으므로(5번), 정확히 마감 레벨을 밟는지로 판정하면
    // 건너뛴 대회는 영영 열려 있게 된다.
    const info = await h.redisService.getFullTournamentInfo(h.tournamentId);
    expect(info!.dashboard.isRegistrationOpen).toBe(false);
  });

  it('7. 전광판은 걷은 참가비 전부를 프라이즈풀로 보여준다', async () => {
    const info = await h.redisService.getFullTournamentInfo(h.tournamentId);

    expect(info!.dashboard.prizePool).toBe(pool);
    expect(info!.dashboard.prizes).toEqual([
      { place: 1, percent: 60, amount: pool * 0.6 },
      { place: 2, percent: 40, amount: pool * 0.4 },
    ]);
  });

  it('8. 3위는 상금권 밖이라 0원으로 탈락한다', async () => {
    // 분배율이 2등까지다. itmCount도 여기서 파생되므로 "인 더 머니인데
    // 받을 몫이 없는 등수"가 생기지 않는다.
    await bustOut('third');

    const row = await participation('third');
    expect(row.finalPlace).toBe(3);
    expect(row.prizeAmount).toBe(0);
    expect(row.status).toBe('ELIMINATED');
  });

  it('9. 2위는 분배율대로 받는다', async () => {
    await bustOut('second');

    const row = await participation('second');
    expect(row.finalPlace).toBe(2);
    expect(row.prizeAmount).toBe(pool * 0.4);
    expect(row.status).toBe('AWARDED');
  });

  it('10. 최후 1인이 남으면 우승 상금이 지급된다', async () => {
    // 마지막 탈락이 activePlayer를 1로 만들면서 tournamentFinished가 돈다.
    const row = await participation('champ');
    expect(row.finalPlace).toBe(1);
    expect(row.prizeAmount).toBe(pool * 0.6);
    expect(row.status).toBe('AWARDED');
  });

  it('11. 나간 상금 총액이 걷은 참가비와 정확히 같다', async () => {
    // 대회 전체를 통틀어 이것 하나가 어긋나면 나머지가 다 맞아도 소용없다.
    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
    });
    const paid = rows.reduce((sum, r) => sum + r.prizeAmount, 0);

    expect(`지급 ${paid}`).toBe(`지급 ${pool}`);
  });

  // ── 도우미 ────────────────────────────────────────────────

  async function participation(userId: string) {
    return await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId },
    });
  }

  /** 진행 중인 핸드를 아무나 이기는 것으로 끝내고 WAITING까지 되돌린다. */
  async function finishHand() {
    for (let guard = 0; guard < 30; guard++) {
      const state = await h.snapshot();
      if (state.phase === GamePhase.WAITING) return;
      if (state.phase === GamePhase.SHOWDOWN) {
        const alive = state.players.filter(p => p && !p.hasFolded).map(p => p!.id);
        await h.dealer.resolveWinners(h.tableId, h.tournamentId, [alive.slice(0, 1)]);
        continue;
      }

      const id = h.turnId(state);
      if (!id) {
        throw new Error(
          `핸드를 끝내지 못했다: phase=${GamePhase[state.phase]} 차례없음`,
        );
      }
      const me = state.players[h.seatOf(state, id)]!;
      const action = me.bet === state.currentBet ? ActionType.CHECK : ActionType.CALL;
      await h.playsync.handleAction(id, h.tableId, { action } as never);
    }

    const state = await h.snapshot();
    const who = state.players
      .filter(p => p)
      .map(p => `${p!.id}(stack=${p!.stack} bet=${p!.bet} allIn=${p!.isAllIn} fold=${p!.hasFolded})`)
      .join(' ');
    throw new Error(
      `핸드가 30번 안에 끝나지 않았다: phase=${GamePhase[state.phase]} ` +
      `currentBet=${state.currentBet} 차례=${h.turnId(state)} / ${who}`,
    );
  }

  /**
   * 지정한 사람이 탈락할 때까지 핸드를 돌린다.
   *
   * 한 판으로 끝난다고 단정할 수 없다. 상대가 폴드하면 희생자가 이겨서
   * 살아남고, 그러면 다음 판을 돌려야 한다 — 실제 대회도 이 모양이다.
   *
   * 등록이 열려 있으면 리바인을 묻는데, 아무도 응답하지 않으면 시간 초과로
   * 거절 처리돼 그대로 탈락한다. 자리를 비운 사람의 실제 경로다.
   */
  async function bustOut(victim: string) {
    for (let hand = 0; hand < 10; hand++) {
      if (await isEliminated(victim)) return;
      await finishHand();

      // 희생자만 짧은 스택으로 만든다. 나머지는 그가 가진 만큼 받아낼 수
      // 있어야 하므로 남은 칩을 몰아준다.
      const before = await h.snapshot();
      const total = before.players.reduce((s, p) => s + (p?.stack ?? 0), 0);
      const others = before.players.filter(p => p && p.id !== victim).length;
      for (const p of before.players) {
        if (!p) continue;
        p.stack = p.id === victim ? 500 : Math.floor((total - 500) / others);
      }
      await h.saveSnapshot(before);

      await h.dealer.startPreFlop(h.tournamentId, h.tableId);

      for (let guard = 0; guard < 20; guard++) {
        const state = await h.snapshot();
        if (state.phase >= GamePhase.SHOWDOWN) break;
        const id = h.turnId(state);
        if (!id) break;

        const me = state.players[h.seatOf(state, id)]!;
        const target = Math.min(me.stack + me.bet, 500);
        const action = target > state.currentBet ? ActionType.RAISE : ActionType.CALL;
        await h.playsync.handleAction(
          id, h.tableId,
          { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never,
        );
      }

      // 쇼다운까지 갔을 때만 승자를 지명한다. 전원이 폴드해 이미 정산된
      // 핸드에 지명하면 페이즈 가드(T8)에 걸린다.
      const state = await h.snapshot();
      if (state.phase !== GamePhase.SHOWDOWN) continue;

      const winners = state.players
        .filter(p => p && !p.hasFolded && p.id !== victim)
        .map(p => p!.id);
      if (winners.length === 0) continue; // 희생자가 이긴 판. 다음 판으로.

      await h.dealer.resolveWinners(h.tableId, h.tournamentId, [winners.slice(0, 1)]);
    }

    throw new Error(`${victim}을(를) 탈락시키지 못했다`);
  }

  async function isEliminated(userId: string) {
    const row = await participation(userId);
    return row.status !== 'PLAYING';
  }
});
