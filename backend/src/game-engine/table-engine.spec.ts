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

describe('TableEngine 핸드 종료', () => {
  function showdownState(): TableState {
    return makeState(
      [
        makePlayer('winner', 0, 0, { isAllIn: true, totalContributed: 500 }),
        makePlayer('loser', 1, 0, { isAllIn: true, totalContributed: 500 }),
      ],
      { phase: GamePhase.SHOWDOWN, pot: 1000, currentTurnSeatIndex: -1 },
    );
  }

  it('승자에게 팟을 지급하고 칩 총량을 보존한다', async () => {
    const state = showdownState();
    const before = totalChips(state);

    await new TableEngine(state).resolveWinner(['winner']);

    expect(state.players[0]!.stack).toBe(1000);
    expect(state.pot).toBe(0);
    expect(totalChips(state)).toBe(before);
  });

  it('정산 직후에는 HAND_END에 머문다', async () => {
    // 리바인 응답을 기다리는 구간이다. WAITING으로 넘어가면 딜러가 다음 핸드를
    // 시작할 수 있게 되어, 리바인 중인 플레이어를 두고 판이 돈다.
    const state = showdownState();

    await new TableEngine(state).resolveWinner(['winner']);

    expect(state.phase).toBe(GamePhase.HAND_END);
  });

  it('리바인 스택을 반영하고 상태 플래그를 되돌린다', async () => {
    const state = makeState(
      [makePlayer('broke', 0, 0, { hasFolded: true, isAllIn: true, bet: 0 })],
      { phase: GamePhase.HAND_END },
    );

    new TableEngine(state).applyRebuy('broke', 10000);

    expect(state.players[0]!.stack).toBe(10000);
    expect(state.players[0]!.isAllIn).toBe(false);
    expect(state.players[0]!.hasFolded).toBe(false);
  });

  it('없는 플레이어의 리바인은 무시한다', async () => {
    const state = makeState([makePlayer('p1', 0, 1000)], { phase: GamePhase.HAND_END });
    const before = totalChips(state);

    expect(() => new TableEngine(state).applyRebuy('ghost', 10000)).not.toThrow();
    expect(totalChips(state)).toBe(before);
  });

  it('테이블 초기화가 WAITING으로 되돌린다', async () => {
    const state = makeState([makePlayer('p1', 0, 1000), makePlayer('p2', 1, 1000)], {
      phase: GamePhase.HAND_END,
    });

    await new TableEngine(state).initTable();

    expect(state.phase).toBe(GamePhase.WAITING);
  });

  it('초기화 시 스택이 0인 좌석을 비운다', async () => {
    const state = makeState([makePlayer('p1', 0, 1000), makePlayer('broke', 1, 0)], {
      phase: GamePhase.HAND_END,
    });

    await new TableEngine(state).initTable();

    expect(state.players[1]).toBeNull();
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

/**
 * 기여액에서 팟 총액을 역산해 makeState에 채운다.
 *
 * pot과 totalContributed가 어긋난 상태로 시작하면 검증하려는 것이 계산 오류인지
 * 픽스처 오류인지 구분할 수 없다. 팟은 낸 칩의 합이라는 사실을 픽스처에 박아둔다.
 */
function potOf(players: TablePlayer[]): number {
  return players.reduce((sum, p) => sum + p.totalContributed, 0);
}

/**
 * `calculateSidePots`는 private이라 직접 부를 수 없다. `nextPhase()`가 페이즈를
 * 넘기기 전에 그것을 호출하고 결과를 `state.sidePots`에 남기므로, 이 공개 경로로
 * 계산 결과를 그대로 관찰한다.
 *
 * `resolveWinner`는 관찰용으로 쓸 수 없다. 정산 후 sidePots를 비우는 데다,
 * 그 전에 `refundUncalledBets`가 기여액 자체를 바꿔놓기 때문에 입력한 기여액에
 * 대한 팟 구조가 아니라 환급된 뒤의 구조를 보게 된다.
 */
function sidePotsOf(players: TablePlayer[]) {
  const state = makeState(players, { pot: potOf(players) });
  new TableEngine(state).nextPhase();
  return state.sidePots;
}

describe('TableEngine 사이드팟 계산', () => {
  // 버그 수정이 아니라 자산 고정이다. 사이드팟은 딜러가 눈으로 검산할 수 없는
  // 유일한 부기라서, 리팩터가 여기를 조용히 망가뜨리면 아무도 알아채지 못한 채
  // 잘못된 금액이 지급된다.

  it('기여액이 갈리면 층마다 팟이 하나씩 생긴다', () => {
    // P3-4: 100/200/300을 낸 셋. 100까지는 셋이 겨루고, 100~200은 둘이,
    // 200~300은 혼자다. 층 수만큼 팟이 나뉜다.
    const pots = sidePotsOf([
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('mid', 1, 0, { totalContributed: 200, isAllIn: true }),
      makePlayer('deep', 2, 700, { totalContributed: 300 }),
    ]);

    expect(pots.map(p => p.amount)).toEqual([300, 200, 100]);
  });

  it('각 팟의 자격자는 그 층까지 낸 사람으로 좁혀진다', () => {
    // 금액만 맞고 자격자가 틀리면 100만 낸 사람이 300짜리 팟을 가져간다.
    // 사이드팟이 존재하는 이유 자체가 이 목록이다.
    const pots = sidePotsOf([
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('mid', 1, 0, { totalContributed: 200, isAllIn: true }),
      makePlayer('deep', 2, 700, { totalContributed: 300 }),
    ]);

    expect(pots.map(p => p.relevantPlayerIds)).toEqual([
      ['short', 'mid', 'deep'],
      ['mid', 'deep'],
      ['deep'],
    ]);
  });

  it('사이드팟 총액은 팟과 정확히 일치한다', () => {
    // 층을 쪼개다 경계를 한 칸 잘못 잡으면 총액이 어긋난다. 팟에 있는 칩보다
    // 많이 나눠주거나, 남은 칩이 정산에서 증발한다.
    const players = [
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('mid', 1, 0, { totalContributed: 200, isAllIn: true }),
      makePlayer('deep', 2, 700, { totalContributed: 300 }),
    ];

    const pots = sidePotsOf(players);

    expect(pots.reduce((sum, p) => sum + p.amount, 0)).toBe(potOf(players));
  });

  it('전원이 같은 금액을 냈으면 팟은 하나다', () => {
    // 사이드팟이 필요 없는 판에서 굳이 쪼개면 분배 로직이 같은 사람에게 여러 번
    // 지급하는 경로로 들어간다.
    const pots = sidePotsOf([
      makePlayer('p1', 0, 700, { totalContributed: 300 }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
      makePlayer('p3', 2, 700, { totalContributed: 300 }),
    ]);

    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(900);
  });

  it('올인 두 명이 같은 층에 서면 그 위로만 팟이 갈린다', () => {
    // 같은 금액 올인 둘은 한 팟을 공유한다. 기여액이 같으면 층이 늘지 않는다는
    // 것을 고정한다 — 여기가 깨지면 빈 팟(amount 0)이 생긴다.
    const pots = sidePotsOf([
      makePlayer('allinA', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('allinB', 1, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('caller', 2, 700, { totalContributed: 300 }),
    ]);

    expect(pots.map(p => p.amount)).toEqual([300, 200]);
    expect(pots[1].relevantPlayerIds).toEqual(['caller']);
  });

  it('한 칩도 내지 않은 플레이어는 어느 팟에도 들어가지 않는다', () => {
    // 지분 없는 사람이 자격자 목록에 끼면, 딜러가 그를 승자로 지명한 순간
    // 남의 칩을 가져간다.
    const pots = sidePotsOf([
      makePlayer('p1', 0, 700, { totalContributed: 300 }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
      makePlayer('sitout', 2, 1000),
    ]);

    expect(pots).toHaveLength(1);
    expect(pots[0].relevantPlayerIds).toEqual(['p1', 'p2']);
  });

  it('폴드한 플레이어가 이미 낸 칩은 팟에 남는다', () => {
    // 홀덤에서 폴드는 낸 칩을 포기하는 것이지 돌려받는 게 아니다. 폴드를
    // 참여자에서 빼면 그 칩만큼 팟이 줄어 승자가 덜 받는다.
    const pots = sidePotsOf([
      makePlayer('folded', 0, 700, { totalContributed: 300, hasFolded: true }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
      makePlayer('p3', 2, 700, { totalContributed: 300 }),
    ]);

    expect(pots[0].amount).toBe(900);
  });

  it('폴드한 플레이어도 자격자 목록에는 남는다', () => {
    // 현재 동작 서술. `calculateSidePots`는 totalContributed > 0만 보고 hasFolded를
    // 보지 않는다. 승자는 계산되지 않고 딜러가 지명하므로 폴드한 사람이 지급
    // 대상이 되지는 않지만, 목록 자체는 "승자 자격"이 아니라 "칩을 낸 사람"이다.
    // 자격 판정을 이 목록에만 의존하는 코드가 생기면 폴드한 사람이 팟을 가져간다.
    const pots = sidePotsOf([
      makePlayer('folded', 0, 700, { totalContributed: 300, hasFolded: true }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
    ]);

    expect(pots[0].relevantPlayerIds).toContain('folded');
  });
});

describe('TableEngine 미콜 베팅 환급', () => {
  /** A가 1000을 밀고 B는 300만 콜한 뒤 폴드한 상태. 700은 아무도 받지 않았다. */
  function uncalledState(): TableState {
    const players = [
      makePlayer('bettor', 0, 9000, { totalContributed: 1000 }),
      makePlayer('folder', 1, 9700, { totalContributed: 300, hasFolded: true }),
    ];
    return makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });
  }

  it('아무도 콜하지 않은 초과분을 돌려준다', async () => {
    // 돌려주지 않으면 상대가 콜하지도 않은 칩을 팟에 걸어놓고 이기는 셈이 된다.
    // 이겨도 자기 돈이라 티가 안 나지만, 사이드팟 자격 계산이 그 금액 기준으로
    // 잡혀 다른 사람의 지분까지 뒤틀린다.
    const state = uncalledState();

    await new TableEngine(state).resolveWinner(['bettor']);

    expect(state.players[0]!.stack).toBe(10300); // 9000 + 환급 700 + 팟 600
  });

  it('환급한 만큼 팟에서 뺀다', async () => {
    // 스택에만 더하고 팟에서 빼지 않으면 칩이 복제된다.
    const state = uncalledState();

    await new TableEngine(state).resolveWinner(['bettor']);

    expect(state.pot).toBe(0);
    expect(totalChips(state)).toBe(20000);
  });

  it('환급 후 기여액이 실제로 콜된 금액까지 내려간다', async () => {
    // totalContributed가 1000으로 남으면 사이드팟이 300/1000 두 층으로 갈리고,
    // 위층 700은 자격자가 혼자라 존재할 이유가 없는 팟이 된다.
    const state = uncalledState();

    await new TableEngine(state).resolveWinner(['bettor']);

    expect(state.players[0]!.totalContributed).toBe(300);
  });

  it('최고액을 낸 사람이 둘이면 환급하지 않는다', async () => {
    // 같은 금액이면 서로 콜한 것이다. 여기서 환급이 돌면 팟이 근거 없이 줄어든다.
    const players = [
      makePlayer('p1', 0, 700, { totalContributed: 300 }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
    ];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });

    await new TableEngine(state).resolveWinner(['p1']);

    expect(state.players[0]!.stack).toBe(1300); // 700 + 팟 600, 환급 없음
  });

  it('칩을 낸 사람이 하나뿐이면 낸 돈을 전부 돌려준다', async () => {
    // 겨룬 상대가 없으니 전액이 미콜이다. 환급이 없으면 자기 돈이 팟에 갇힌 채
    // 사이드팟 자격자가 자기 혼자인 팟으로 돌아온다.
    const players = [makePlayer('lonely', 0, 9000, { totalContributed: 1000 })];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });

    await new TableEngine(state).resolveWinner(['lonely']);

    expect(state.players[0]!.stack).toBe(10000);
    expect(state.players[0]!.totalContributed).toBe(0);
  });

  it('환급이 걸려도 칩 총량은 변하지 않는다', async () => {
    const state = uncalledState();
    const before = totalChips(state);

    await new TableEngine(state).resolveWinner(['bettor']);

    expect(totalChips(state)).toBe(before);
  });
});

describe('TableEngine 사이드팟 정산', () => {
  it('갈린 팟을 각 자격자에게 따로 지급한다', async () => {
    // 올인 100이 300짜리 팟까지 쓸어가면 안 되고, 자기 층의 300만 가져가야 한다.
    const players = [
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('mid', 1, 0, { totalContributed: 300, isAllIn: true }),
      makePlayer('deep', 2, 700, { totalContributed: 300 }),
    ];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });

    await new TableEngine(state).resolveWinner(['short', 'deep']);

    expect(state.players[0]!.stack).toBe(300); // 전원이 겨룬 100층
    expect(state.players[2]!.stack).toBe(1100); // 700 + 100~300층 400
  });

  it('갈린 팟을 정산해도 칩 총량이 보존된다', async () => {
    // 이 프로젝트에서 카드는 실물이고 칩만 디지털이다. 부기가 틀리면 되돌릴
    // 근거가 테이블 위에 남지 않는다.
    const players = [
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('mid', 1, 0, { totalContributed: 300, isAllIn: true }),
      makePlayer('deep', 2, 700, { totalContributed: 300 }),
    ];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });
    const before = totalChips(state);

    await new TableEngine(state).resolveWinner(['short', 'deep']);

    expect(totalChips(state)).toBe(before);
  });

  it('폴드한 플레이어가 낸 칩은 승자에게 간다', async () => {
    const players = [
      makePlayer('folded', 0, 700, { totalContributed: 300, hasFolded: true }),
      makePlayer('winner', 1, 700, { totalContributed: 300 }),
      makePlayer('loser', 2, 700, { totalContributed: 300 }),
    ];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });
    const before = totalChips(state);

    await new TableEngine(state).resolveWinner(['winner']);

    expect(state.players[1]!.stack).toBe(1600); // 700 + 팟 900
    expect(totalChips(state)).toBe(before);
  });

  it('자격자가 아무도 승자로 지명되지 않은 팟은 증발한다', async () => {
    // 현재 동작 서술이자 알려진 구멍이다. 딜러가 1등만 찍고 넘어가면, 그 1등이
    // 자격 없는 상위 팟은 지급되지 않은 채 `state.pot = 0`으로 지워진다.
    // 숏스택이 이기고 나머지 둘의 승부를 안 찍는 것은 흔한 조작 실수라
    // 실제로 도달 가능한 경로다. 이 티켓은 테스트만 추가하므로 고치지 않고
    // 고정만 해둔다 — 수정이 들어오면 이 테스트가 깨지면서 드러난다.
    const players = [
      makePlayer('short', 0, 0, { totalContributed: 100, isAllIn: true }),
      makePlayer('p2', 1, 700, { totalContributed: 300 }),
      makePlayer('p3', 2, 700, { totalContributed: 300 }),
    ];
    const state = makeState(players, {
      phase: GamePhase.SHOWDOWN,
      pot: potOf(players),
      currentTurnSeatIndex: -1,
    });
    const before = totalChips(state);

    await new TableEngine(state).resolveWinner(['short']);

    expect(state.players[0]!.stack).toBe(300);
    expect(totalChips(state)).toBe(before - 400); // 100~300층 400이 사라진다
  });
});
