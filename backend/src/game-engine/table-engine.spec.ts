import { TableEngine } from './table-engine';
import { ActionType, GamePhase, TablePlayer, TableState } from './types';

function makePlayer(
  id: string,
  seatIndex: number,
  stack: number,
  overrides: Partial<TablePlayer> = {},
): TablePlayer {
  return {
    id,
    tableId: 't1',
    nickname: id,
    seatIndex,
    stack,
    bet: 0,
    hasFolded: false,
    hasChecked: false,
    isAllIn: false,
    totalContributed: 0,
    ...overrides,
  };
}

function makeState(
  players: (TablePlayer | null)[],
  overrides: Partial<TableState> = {},
): TableState {
  return {
    phase: GamePhase.PRE_FLOP,
    players,
    buttonUser: 0,
    currentTurnSeatIndex: 0,
    pot: 0,
    sidePots: [],
    currentBet: 0,
    smallBlind: 100,
    ante: false,
    tournamentId: 'tour1',
    ...overrides,
  };
}

/** 테이블 위의 칩 총량. 어떤 액션도 이 값을 바꾸면 안 된다. */
function totalChips(state: TableState): number {
  const stacks = state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0);
  return stacks + state.pot;
}

describe('TableEngine RAISE 입력 검증', () => {
  let state: TableState;
  let engine: TableEngine;

  beforeEach(() => {
    // 0번 좌석 차례, 현재 베팅 100 (0번은 아직 안 냄)
    state = makeState([makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000, { bet: 100 })], {
      currentTurnSeatIndex: 0,
      currentBet: 100,
      pot: 100,
    });
    engine = new TableEngine(state);
  });

  it('음수 금액으로 레이즈하면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, -1000)).rejects.toThrow();
  });

  it('음수 레이즈를 시도해도 칩 총량이 변하지 않는다', async () => {
    const before = totalChips(state);

    await expect(engine.act(0, ActionType.RAISE, -1000)).rejects.toThrow();

    expect(totalChips(state)).toBe(before);
    expect(state.players[0]!.stack).toBe(1000);
    expect(state.pot).toBe(100);
  });

  it('현재 베팅과 같은 금액은 레이즈가 아니므로 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, 100)).rejects.toThrow();
  });

  it('현재 베팅보다 낮은 금액으로 레이즈하면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, 50)).rejects.toThrow();
  });

  it('소수점 금액으로 레이즈하면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, 150.5)).rejects.toThrow();
  });

  it('Infinity 금액으로 레이즈하면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, Infinity)).rejects.toThrow();
  });

  it('NaN 금액으로 레이즈하면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE, NaN)).rejects.toThrow();
  });

  it('금액을 아예 안 보내면 거부한다', async () => {
    await expect(engine.act(0, ActionType.RAISE)).rejects.toThrow();
  });

  it('정상 레이즈는 통과하고 칩 총량이 보존된다', async () => {
    const before = totalChips(state);

    await engine.act(0, ActionType.RAISE, 300);

    expect(state.players[0]!.bet).toBe(300);
    expect(state.players[0]!.stack).toBe(700);
    expect(state.currentBet).toBe(300);
    expect(totalChips(state)).toBe(before);
  });

  it('스택보다 큰 금액을 레이즈하면 올인으로 처리한다', async () => {
    const before = totalChips(state);

    await engine.act(0, ActionType.RAISE, 5000);

    expect(state.players[0]!.stack).toBe(0);
    expect(state.players[0]!.isAllIn).toBe(true);
    expect(state.players[0]!.bet).toBe(1000);
    expect(totalChips(state)).toBe(before);
  });
});
