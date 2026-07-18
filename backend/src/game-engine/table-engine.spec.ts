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

describe('TableEngine TIME_OUT', () => {
  it('콜이 필요 없으면 체크로 처리한다', async () => {
    // 예전에는 삼항의 else 가지가 false를 평가하고 버려서 아무 상태도 바뀌지 않았다.
    const state = makeState(
      [makePlayer('p1', 0, 900, { bet: 100 }), makePlayer('p2', 1, 900, { bet: 100 })],
      { currentTurnSeatIndex: 0, currentBet: 100, pot: 200 },
    );

    await new TableEngine(state).act(0, ActionType.TIME_OUT);

    expect(state.players[0]!.hasChecked).toBe(true);
    expect(state.players[0]!.hasFolded).toBe(false);
  });

  it('AFK 유저가 있어도 베팅 라운드가 끝난다', async () => {
    // P1-1 회귀: hasChecked가 false로 남으면 shouldGoToNextPhase가 영영 참이 되지
    // 않아 턴만 무한히 돈다.
    const state = makeState(
      [
        makePlayer('afk', 0, 900, { bet: 100 }),
        makePlayer('p2', 1, 900, { bet: 100, hasChecked: true }),
      ],
      { currentTurnSeatIndex: 0, currentBet: 100, pot: 200 },
    );

    await new TableEngine(state).act(0, ActionType.TIME_OUT);

    expect(state.phase).toBe(GamePhase.FLOP);
  });

  it('콜 금액이 부족하면 폴드로 처리한다', async () => {
    const state = makeState(
      [makePlayer('p1', 0, 900, { bet: 100 }), makePlayer('p2', 1, 700, { bet: 300 })],
      { currentTurnSeatIndex: 0, currentBet: 300, pot: 400 },
    );

    await new TableEngine(state).act(0, ActionType.TIME_OUT);

    expect(state.players[0]!.hasFolded).toBe(true);
  });

  it('올인 플레이어는 폴드시키지 않는다', async () => {
    // N-8 회귀: 올인은 더 낼 칩이 없어 bet < currentBet이지만, 이미 낸 칩에 대한
    // 쇼다운 권리가 있다. 폴드시키면 칩은 팟에 남고 승리 자격만 사라진다.
    const state = makeState(
      [
        makePlayer('allin', 0, 0, { bet: 100, isAllIn: true, totalContributed: 100 }),
        makePlayer('p2', 1, 700, { bet: 300, totalContributed: 300 }),
        makePlayer('p3', 2, 700, { bet: 300, totalContributed: 300 }),
      ],
      { currentTurnSeatIndex: 0, currentBet: 300, pot: 700 },
    );

    await new TableEngine(state).act(0, ActionType.TIME_OUT);

    expect(state.players[0]!.hasFolded).toBe(false);
    expect(state.players[0]!.isAllIn).toBe(true);
  });
});

describe('TableEngine startPreFlop', () => {
  it('헤즈업에서는 버튼이 SB다', async () => {
    // P1-4 회귀: 홀덤 헤즈업 규칙은 버튼 = SB. 예전에는 버튼 다음 사람을 SB로
    // 잡아서 2인일 때 버튼이 BB가 됐다.
    const state = makeState([makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000)], {
      buttonUser: 1,
      smallBlind: 100,
    });

    new TableEngine(state).startPreFlop();

    expect(state.buttonUser).toBe(0);
    expect(state.players[0]!.bet).toBe(100); // 버튼 = SB
    expect(state.players[1]!.bet).toBe(200); // 상대 = BB
  });

  it('헤즈업 프리플롭의 첫 액션은 버튼(SB)이다', async () => {
    const state = makeState([makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000)], {
      buttonUser: 1,
      smallBlind: 100,
    });

    new TableEngine(state).startPreFlop();

    expect(state.currentTurnSeatIndex).toBe(0);
  });

  it('3인 이상에서는 버튼 다음이 SB다', async () => {
    const state = makeState(
      [makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000), makePlayer('p3', 2, 1000)],
      { buttonUser: 2, smallBlind: 100 },
    );

    new TableEngine(state).startPreFlop();

    expect(state.buttonUser).toBe(0);
    expect(state.players[1]!.bet).toBe(100);
    expect(state.players[2]!.bet).toBe(200);
    expect(state.currentTurnSeatIndex).toBe(0); // BB 다음 = 버튼
  });

  it('활성 플레이어가 1명이면 시작하지 않는다', async () => {
    // 예전에는 순환 탐색이 같은 좌석을 세 번 반환해 한 명이 BTN=SB=BB로
    // 블라인드를 삼중 지불했다.
    const state = makeState([makePlayer('p1', 0, 1000), null], { buttonUser: 0 });

    expect(() => new TableEngine(state).startPreFlop()).toThrow(
      '게임을 시작하기에 충분한 플레이어가 없습니다.',
    );
    expect(state.players[0]!.bet).toBe(0);
    expect(state.pot).toBe(0);
  });

  it('활성 플레이어가 없으면 크래시가 아니라 에러로 거부한다', async () => {
    // 예전에는 players[-1]! 접근으로 TypeError가 나서 프로세스가 죽었다.
    // toThrow()만으로는 그 크래시와 정상 거부가 구분되지 않으므로 메시지를 본다.
    const state = makeState([makePlayer('p1', 0, 0), makePlayer('p2', 1, 0)]);

    expect(() => new TableEngine(state).startPreFlop()).toThrow(
      '게임을 시작하기에 충분한 플레이어가 없습니다.',
    );
  });

  it('블라인드로 전원이 올인되면 첫 턴을 -1로 둔다', async () => {
    // N-8: 액션 가능자가 진짜 없는데 SB를 턴으로 지정하면, 곧이어 도착하는
    // 타임아웃이 올인 플레이어를 폴드시킨다. 없으면 없다고 둔다.
    const state = makeState([makePlayer('p1', 0, 100), makePlayer('p2', 1, 200)], {
      buttonUser: 1,
      smallBlind: 100,
    });

    new TableEngine(state).startPreFlop();

    expect(state.players[0]!.isAllIn).toBe(true);
    expect(state.players[1]!.isAllIn).toBe(true);
    expect(state.currentTurnSeatIndex).toBe(-1);
  });

  it('시작해도 칩 총량은 변하지 않는다', async () => {
    const state = makeState(
      [makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000), makePlayer('p3', 2, 1000)],
      { buttonUser: 2, smallBlind: 100 },
    );
    const before = totalChips(state);

    new TableEngine(state).startPreFlop();

    expect(totalChips(state)).toBe(before);
  });
});
