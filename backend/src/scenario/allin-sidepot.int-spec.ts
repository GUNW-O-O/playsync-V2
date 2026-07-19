import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, setupTournament } from './harness';

/**
 * 올인으로 사이드팟이 갈리고, 딜러가 승자를 지명하는 경로.
 *
 * **이 시나리오가 가장 중요하다.** 승자는 계산되지 않고 딜러가 입력한다. 그
 * 대신 부기 — 사이드팟이 몇 개이고 누가 어느 팟의 자격자인지 — 는 시스템이
 * 책임진다. 딜러 콘솔은 그 정보를 보고 승자를 찍으므로, **승자 결정 페이즈에서
 * 나가는 정보가 정확하지 않으면 딜러가 잘못 찍는다.** 그리고 카드가 실물이라
 * 잘못 나간 지급을 되돌릴 근거가 테이블 위에 남지 않는다.
 *
 * 스택을 일부러 다르게 잡는다. 전원 같은 스택이면 팟이 갈리지 않아 이 경로가
 * 아예 실행되지 않는다.
 */
describe('시나리오 — 올인과 사이드팟', () => {
  let h: Harness;
  const PLAYERS = ['short', 'mid', 'deep'];

  const STACKS: Record<string, number> = { short: 1000, mid: 3000, deep: 10000 };
  const chips = 1000 + 3000 + 10000;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);

    // 착석은 전원 같은 스택으로 이뤄진다. 사이드팟이 갈리는 판을 만들기 위해
    // 시작 스택만 손으로 벌린다 — 검증 대상은 착석이 아니라 정산이다.
    const state = await h.snapshot();
    for (const p of state.players) {
      if (p) p.stack = STACKS[p.id];
    }
    await h.saveSnapshot(state);
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 프리플랍이 열린다', async () => {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '프리플랍', chips);
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
  });

  it('2. 차례대로 올인해서 층이 갈린다', async () => {
    // 각자 자기 스택 전부를 민다. short가 먼저 바닥나고, mid가 그 위에
    // 한 층을 더 만든다. deep은 mid의 금액까지만 콜한다.
    for (let guard = 0; guard < 12; guard++) {
      const state = await h.snapshot();
      if (state.phase !== GamePhase.PRE_FLOP) break;

      const id = h.turnId(state);
      if (!id) break;
      const me = state.players[h.seatOf(state, id)]!;

      // 이미 낸 것까지 합쳐 3000이 상한이다. deep이 더 밀면 아무도 콜하지
      // 못해 환급으로 되돌아오므로, 층 구조를 보려면 여기서 멈춰야 한다.
      const target = Math.min(me.stack + me.bet, 3000);
      const action = target > state.currentBet ? ActionType.RAISE : ActionType.CALL;

      await h.playsync.handleAction(
        id, h.tableId,
        { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never,
      );
      await checkInvariants(h, `프리플랍 ${id} ${action}`, chips);
    }

    const state = await h.snapshot();
    expect(state.players[h.seatOf(state, 'short')]!.isAllIn).toBe(true);
    expect(state.players[h.seatOf(state, 'mid')]!.isAllIn).toBe(true);
  });

  it('3. 쇼다운에 도달하면 차례가 없다', async () => {
    // 액션할 수 있는 사람이 없으면 지름길로 쇼다운에 간다. 이때 차례가 남으면
    // 딜러가 승자를 입력하는 동안 남의 화면에 카운트다운이 돈다.
    for (let guard = 0; guard < 12; guard++) {
      const state = await h.snapshot();
      if (state.phase === GamePhase.SHOWDOWN) break;
      const id = h.turnId(state);
      if (!id) break;

      await h.playsync.handleAction(id, h.tableId, { action: ActionType.CHECK } as never);
      await checkInvariants(h, `${GamePhase[state.phase]} ${id} 체크`, chips);
    }

    const state = await checkInvariants(h, '쇼다운', chips);
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.currentTurnSeatIndex).toBe(-1);
  });

  it('4. 딜러 콘솔이 보는 사이드팟이 정확하다', async () => {
    // **승자 결정 페이즈의 정보 정확도.** 딜러는 이 목록을 보고 찍는다.
    const state = await h.snapshot();

    expect(state.sidePots).toHaveLength(2);

    // 1층: 전원이 1000씩 겨룬 3000.
    expect(state.sidePots[0].amount).toBe(3000);
    expect([...state.sidePots[0].relevantPlayerIds].sort())
      .toEqual(['deep', 'mid', 'short']);

    // 2층: short는 낼 돈이 없었다. mid와 deep이 2000씩 더 낸 4000.
    expect(state.sidePots[1].amount).toBe(4000);
    expect([...state.sidePots[1].relevantPlayerIds].sort()).toEqual(['deep', 'mid']);

    // 총액이 팟과 맞는다 — 갈라놓고 어긋나면 지급에서 증발한다.
    expect(state.sidePots.reduce((s, p) => s + p.amount, 0)).toBe(state.pot);
  });

  it('5. 1등만 찍으면 거부하고 어느 팟인지 알려준다', async () => {
    // T15. 숏스택이 이겼을 때 1등만 찍고 나머지 둘의 승부를 안 찍는 것은 흔한
    // 조작 실수다. 예전에는 그 팟이 조용히 증발했다.
    await expect(
      h.dealer.resolveWinners(h.tableId, h.tournamentId, ['short']),
    ).rejects.toThrow(/지명되지 않은 팟/);

    // 거부는 아무것도 건드리지 않는다. 딜러가 다시 찍을 수 있어야 한다.
    const state = await checkInvariants(h, '거부 후', chips);
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.pot).toBe(7000);
  });

  it('6. 자격 없는 사람을 상위 팟 승자로 지명해도 그 팟은 여전히 미지명이다', async () => {
    // short는 2층의 자격자가 아니다. 순서를 바꿔 넣어도 2층은 채워지지 않는다.
    await expect(
      h.dealer.resolveWinners(h.tableId, h.tournamentId, ['short', 'short']),
    ).rejects.toThrow(/지명되지 않은 팟/);

    await checkInvariants(h, '중복 지명 거부 후', chips);
  });

  it('7. 순위대로 지명하면 층마다 알맞은 사람에게 간다', async () => {
    // 올인 100은 900을 가져갈 수 없고 자기 층만 가져간다 — 사이드팟이
    // 존재하는 이유 그 자체다. 남은 층은 그 아래 순위가 가져간다.
    await h.dealer.resolveWinners(h.tableId, h.tournamentId, ['short', 'mid']);

    const state = await checkInvariants(h, '정산', chips);
    expect(state.players[h.seatOf(state, 'short')]!.stack).toBe(3000);
    expect(state.players[h.seatOf(state, 'mid')]!.stack).toBe(4000);
    expect(state.players[h.seatOf(state, 'deep')]!.stack).toBe(chips - 3000 - 4000);
    expect(state.pot).toBe(0);
  });

  it('8. 정산이 끝나면 다음 핸드를 받을 수 있는 상태다', async () => {
    const state = await checkInvariants(h, '다음 핸드', chips);
    expect(state.phase).toBe(GamePhase.WAITING);
    expect(state.sidePots).toHaveLength(0);
    expect(state.players.every(p => p === null || !p.isAllIn)).toBe(true);
  });
});
