import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * 보드 하이 — 커뮤니티 카드가 그대로 모두의 최고 핸드가 되는 판.
 *
 * 드물지 않다. 보드에 스트레이트나 풀하우스가 깔리면 두 사람 손에 뭐가 있든
 * 같은 핸드가 되고, 팟은 나눠 갖는다.
 *
 * 예전에는 표현할 방법이 아예 없었다. 딜러 입력이 순위 배열이라 팟마다 한
 * 명을 골랐고, **먼저 찍힌 사람이 전부 가져갔다.** 칩 총량은 맞으니
 * `checkInvariants`도 조용하다 — 조용히 틀린 사람에게 나가는 종류의 버그다.
 * 카드가 실물이라 되돌릴 근거도 테이블 위에 남지 않는다.
 */
describe('시나리오 — 보드 하이 (동점 분배)', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = SCENARIO.startStack * PLAYERS.length;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
  });

  afterAll(async () => {
    await h.close();
  });

  /** 전원이 콜/체크만 해서 쇼다운까지 간다. 아무도 폴드하지 않는다. */
  async function playToShowdown() {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    for (let guard = 0; guard < 40; guard++) {
      const state = await h.snapshot();
      if (state.phase >= GamePhase.SHOWDOWN) return state;

      const id = h.turnId(state);
      if (!id) break;
      const me = state.players[h.seatOf(state, id)]!;
      const action = me.bet === state.currentBet ? ActionType.CHECK : ActionType.CALL;
      await h.playsync.handleAction(id, h.tableId, { action } as never);
    }

    throw new Error('쇼다운에 도달하지 못했다');
  }

  it('1. 전원이 살아서 쇼다운에 도달한다', async () => {
    const state = await playToShowdown();

    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.players.every(p => p === null || !p.hasFolded)).toBe(true);
    await checkInvariants(h, '쇼다운', chips);
  });

  it('2. 딜러가 전원을 한 그룹으로 지명하면 팟이 나뉜다', async () => {
    const before = await h.snapshot();
    const pot = before.pot;
    const stacksBefore = PLAYERS.map(id => before.players[h.seatOf(before, id)]!.stack);

    // 동점 그룹 하나. 순위 배열이었다면 p0이 팟을 전부 가져갔을 자리다.
    await h.dealer.resolveWinners(h.tableId, h.tournamentId, [PLAYERS]);

    const after = await checkInvariants(h, '동점 정산', chips);
    const share = pot / PLAYERS.length;

    PLAYERS.forEach((id, i) => {
      expect(`${id} 스택 ${after.players[h.seatOf(after, id)]!.stack}`)
        .toBe(`${id} 스택 ${stacksBefore[i] + share}`);
    });
    expect(after.pot).toBe(0);
  });

  it('3. 아무도 탈락하지 않는다', async () => {
    // 전원이 낸 만큼 돌려받았으니 스택이 0인 사람이 없다. 여기서 탈락이
    // 발생하면 분배가 틀렸다는 뜻이다.
    const state = await h.snapshot();
    expect(state.players.filter(p => p !== null)).toHaveLength(PLAYERS.length);

    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
    });
    expect(rows.every(r => r.status !== 'ELIMINATED')).toBe(true);
  });

  it('4. 다음 핸드를 받을 수 있는 상태로 돌아온다', async () => {
    const state = await checkInvariants(h, '다음 핸드', chips);
    expect(state.phase).toBe(GamePhase.WAITING);
    expect(state.sidePots).toHaveLength(0);
  });

  it('5. 빈 동점 그룹은 거부한다', async () => {
    // `[[]]`는 "1위가 아무도 없다"가 된다. 계약(zod)이 1차로 막지만 서비스도
    // 막아야 한다 — WS만 경계가 아니다.
    await expect(
      h.dealer.resolveWinners(h.tableId, h.tournamentId, [[]]),
    ).rejects.toThrow(/유효한 승자/);
  });
});
