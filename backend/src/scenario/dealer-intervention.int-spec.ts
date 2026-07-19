import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * 딜러가 게임 진행에 개입하는 경로.
 *
 * 오프라인 대회라 자리를 비우는 사람이 생긴다. 카드가 실물이므로 딜러가 그
 * 사람의 카드를 회수하며 폴드시키고, 아예 나간 사람은 킥해서 탈락 처리한다.
 * **딜러가 게임 진행의 트리거**라는 이 프로젝트의 전제가 드러나는 자리다.
 *
 * T8이 고친 것이 여기다 — `DEALER_FOLD`/`DEALER_KICK`이 "차례가 아닌 사람"
 * 분기에만 있어서, 정작 **차례인 사람을 접을 수 없었다.** 프리플랍의 첫 행동자는
 * UTG이고 UTG는 정의상 현재 차례라, 자리를 비운 사람이 UTG면 딜러가 아무것도
 * 할 수 없었다. 진행을 막는 쪽이 고장나 있었던 셈이다.
 */
describe('시나리오 — 딜러 개입 (폴드 · 킥)', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2', 'p3'];
  let chips: number;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
    chips = SCENARIO.startStack * PLAYERS.length;
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 프리플랍이 열리고 UTG 차례가 된다', async () => {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '프리플랍', chips);
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    expect(h.turnId(state)).not.toBeNull();
  });

  it('2. 차례인 사람을 딜러가 접으면 진행이 이어진다', async () => {
    // T8의 핵심. 예전에는 이 호출이 아무 일도 하지 않아 테이블이 멈췄다.
    const before = await h.snapshot();
    const utg = h.turnId(before)!;

    await h.dealer.handleDealerAction(h.tournamentId, h.tableId, utg, 'FOLD');

    const state = await checkInvariants(h, `딜러폴드 ${utg}`, chips);
    expect(state.players[h.seatOf(state, utg)]!.hasFolded).toBe(true);
    // 차례가 넘어갔다 — 멈추지 않았다는 뜻이다.
    expect(h.turnId(state)).not.toBe(utg);
  });

  it('3. 차례가 아닌 사람을 접어도 현재 차례를 빼앗지 않는다', async () => {
    // 지금 액션을 기다리는 사람에게서 차례를 가져가면 그가 영영 행동하지 못한다.
    const before = await h.snapshot();
    const current = h.turnId(before)!;
    const other = before.players.find(
      p => p && !p.hasFolded && p.id !== current,
    )!.id;

    await h.dealer.handleDealerAction(h.tournamentId, h.tableId, other, 'FOLD');

    const state = await checkInvariants(h, `딜러폴드 비차례 ${other}`, chips);
    expect(state.players[h.seatOf(state, other)]!.hasFolded).toBe(true);
    expect(h.turnId(state)).toBe(current);
  });

  it('4. 남은 둘이 콜해서 라운드가 넘어간다', async () => {
    for (let guard = 0; guard < 8; guard++) {
      const state = await h.snapshot();
      if (state.phase !== GamePhase.PRE_FLOP) break;

      const id = h.turnId(state)!;
      const seat = h.seatOf(state, id);
      const action = state.players[seat]!.bet === state.currentBet
        ? ActionType.CHECK
        : ActionType.CALL;

      await h.playsync.handleAction(id, h.tableId, { action } as never);
      await checkInvariants(h, `프리플랍 ${id} ${action}`, chips);
    }

    const state = await h.snapshot();
    expect(state.phase).toBe(GamePhase.FLOP);
  });

  it('5. 킥해도 자리와 칩은 테이블에 남는다', async () => {
    // 킥은 폴드와 다르지만 **자리에서 치우는 것도 아니다.**
    //
    // 대회에서는 나가지만 스택은 그 자리에 남아 앤티와 블라인드로 서서히
    // 녹는다 — 그 칩은 테이블에 남은 사람들이 가져간다. 즉시 회수하면 그
    // 칩이 어디로 갔는지 설명할 수 없고, 오프라인에서는 자리를 비운 사람이
    // 돌아올 수도 있다.
    const before = await h.snapshot();
    const victim = before.players.find(p => p && p.hasFolded)!.id;
    const stackBefore = before.players[h.seatOf(before, victim)]!.stack;

    await h.dealer.handleDealerAction(h.tournamentId, h.tableId, victim, 'KICK');

    const state = await checkInvariants(h, `킥 ${victim}`, chips);
    const seat = state.players[h.seatOf(state, victim)];
    expect(seat).not.toBeNull();
    expect(seat!.stack).toBe(stackBefore);

    // 대회 참가자로서는 탈락이다.
    const row = await h.prisma.tournamentParticipation.findFirst({
      where: { tournamentId: h.tournamentId, userId: victim },
    });
    expect(row!.status).toBe('ELIMINATED');
  });

  it('6. 킥된 사람은 무엇을 눌러도 폴드가 된다', async () => {
    // 조작을 막는 방법이 "연결을 끊는다"가 아니라 "액션을 폴드로 바꾼다"인
    // 이유: 태블릿은 좌석에 고정돼 있고 망이 행사장 WiFi라, 같은 망의 단말이
    // WS를 직접 열 수 있다. UI의 제약은 서버의 제약이 아니다.
    const state = await h.snapshot();
    const victim = state.players.find(p => p && p.hasFolded)!.id;
    const context = await h.redisService.getUserContext(h.tournamentId, victim);
    expect(context!.status).toBe('KICKED');

    // 레이즈를 보내도 스택이 줄지 않는다 — 폴드로 바뀌기 때문이다.
    const stackBefore = state.players[h.seatOf(state, victim)]!.stack;
    await h.playsync.handleAction(
      victim, h.tableId, { action: ActionType.RAISE, amount: 500 } as never,
    ).catch(() => undefined);

    const after = await checkInvariants(h, `킥된 사람 레이즈 ${victim}`, chips);
    expect(after.players[h.seatOf(after, victim)]!.stack).toBe(stackBefore);
    expect(after.players[h.seatOf(after, victim)]!.hasFolded).toBe(true);
  });

  it('7. 같은 사람을 두 번 킥해도 인원이 두 번 줄지 않는다', async () => {
    // N-7. 재시도가 붙는 순간 중복 도착이 정상 경로가 된다.
    const state = await h.snapshot();
    const victim = state.players.find(p => p && p.hasFolded)!.id;
    const before = await h.prisma.tournament.findUniqueOrThrow({
      where: { id: h.tournamentId },
    });

    await h.dealer.handleDealerAction(h.tournamentId, h.tableId, victim, 'KICK');

    const after = await h.prisma.tournament.findUniqueOrThrow({
      where: { id: h.tournamentId },
    });
    expect(after.activePlayers).toBe(before.activePlayers);
  });

  it('8. 없는 사람을 지목하면 거절한다', async () => {
    await expect(
      h.dealer.handleDealerAction(h.tournamentId, h.tableId, '없는유저', 'FOLD'),
    ).rejects.toThrow(/대상 플레이어/);
  });
});
