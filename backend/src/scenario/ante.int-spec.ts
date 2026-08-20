import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * 앤티가 걸린 핸드를 쇼다운·정산까지 끝까지 돌린다.
 *
 * T58. `TableEngine.payAnte`가 `executeBet`을 거치지 않고 스택에서 직접
 * 빼서 `state.pot`에만 더했다. `totalContributed`가 안 올라 사이드팟
 * 계산(`calculateSidePots`)이 앤티를 못 보고, `resolveWinner`가 마지막에
 * `pot`을 0으로 지우는 순간 그 차액이 증발했다.
 *
 * `harness.ts`의 `checkInvariants`는 "사이드팟 총액은 팟과 일치한다"를
 * 이미 검사한다. 그런데도 이 버그를 못 잡은 이유는 **`ante: true`인
 * 시나리오가 쇼다운·정산까지 간 적이 없어서**다 — `totalChips`가
 * `스택 합 + pot`이라 앤티가 팟 안에 머무는 동안은 증발이 보이지 않는다.
 * `resolveWinner`가 `pot = 0`으로 지우는 그 순간에야 드러난다. 그래서 이
 * 시나리오는 반드시 정산까지 간다 — 프리플랍만 찍고 끝내면 이 티켓의 값이
 * 없다.
 *
 * 3인 · sb 100 · 앤티 20(=sb/5)은 브리핑이 실측한 재현 조건과 같다
 * (블라인드 직후 pot 360, 정산 후 테이블 위 총 칩이 30000 밑으로 준다).
 */
describe('시나리오 — 앤티', () => {
  let h: Harness;
  const PLAYERS = ['a', 'b', 'c'];
  const chips = SCENARIO.startStack * PLAYERS.length;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS, {
      blindStructure: [{ lv: 1, sb: 100, ante: true, duration: 60 }],
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 프리플랍 — 앤티가 블라인드보다 먼저 걷히고 팟에 반영된다', async () => {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    const state = await checkInvariants(h, '프리플랍', chips);
    expect(state.phase).toBe(GamePhase.PRE_FLOP);
    // state.ante는 boolean이 아니라 금액이다 — DealerService.startPreFlop이
    // deriveAnteAmount(sb, hasAnte)로 채운다.
    expect(state.ante).toBe(20);
    // 앤티 3인분(60) + SB 100 + BB 200.
    expect(state.pot).toBe(360);
  });

  it('2. 쇼다운까지 아무도 레이즈하지 않아도 앤티가 사이드팟에 담긴다', async () => {
    // 전원이 체크/콜로만 진행해 쇼다운까지 간다. 사이드팟이 하나뿐이어도
    // 앤티가 totalContributed에 없으면 그 팟의 합이 팟보다 작아진다 —
    // checkInvariants 검사 2("사이드팟 총액은 팟과 일치한다")가 그 자리다.
    for (let guard = 0; guard < 20; guard++) {
      const state = await h.snapshot();
      if (state.phase === GamePhase.SHOWDOWN) break;

      const id = h.turnId(state);
      if (!id) break;
      const me = state.players[h.seatOf(state, id)]!;
      const action = me.bet < state.currentBet ? ActionType.CALL : ActionType.CHECK;

      await h.playsync.handleAction(id, h.tableId, { action } as never);
      await checkInvariants(h, `${GamePhase[state.phase]} ${id} ${action}`, chips);
    }

    const state = await checkInvariants(h, '쇼다운', chips);
    expect(state.phase).toBe(GamePhase.SHOWDOWN);

    // 딜러 콘솔이 보는 값 — checkInvariants와 별개로 여기서도 명시한다.
    // 앤티 60을 포함한 660이어야 한다(600이면 브리핑이 실측한 그 증발이다).
    const sidePotSum = state.sidePots.reduce((sum, p) => sum + p.amount, 0);
    expect(sidePotSum).toBe(state.pot);
    expect(state.pot).toBe(660);
  });

  it('3. 정산해도 앤티만큼 칩이 사라지지 않는다', async () => {
    // 승자는 계산되지 않고 딜러가 입력한다 — 셋 다 살아 있으니 공동 우승으로
    // 지명한다. 이 테스트가 보는 것은 승부가 아니라 부기다.
    await h.dealer.resolveWinners(h.tableId, h.tournamentId, [['a', 'b', 'c']]);

    // resolveWinner가 pot을 0으로 지우는 순간이 T58의 증발이 드러나는
    // 자리다 — checkInvariants 검사 1(칩 총량 보존)이 여기서 진짜로 시험된다.
    const state = await checkInvariants(h, '정산', chips);
    expect(state.pot).toBe(0);
  });

  it('4. 다음 핸드를 받을 수 있는 상태다', async () => {
    const state = await checkInvariants(h, '다음 핸드', chips);
    expect(state.phase).toBe(GamePhase.WAITING);
  });
});
