import { GamePhase, TableState } from 'src/game-engine/types';
import { planPause } from './turn-clock';

/**
 * 정지에서 돌아온 뒤 턴 시계를 다루는 규칙(T94·T95).
 *
 * 둘이 **같은 판정**(차례가 살아 있나)을 쓰고 서로 다른 일을 한다. 판정이
 * 갈리면 정지는 걸렸는데 재개가 안 되는 테이블이 생기므로, 같은 입력을 둘에
 * 나란히 먹여 본다.
 */
const NOW = 1_000;

function stateOf(over: Partial<TableState> = {}): TableState {
  return {
    phase: GamePhase.PRE_FLOP,
    currentTurnSeatIndex: 1,
    players: [{ id: 'seat-0' }, { id: 'seat-1' }],
    ...over,
  } as unknown as TableState;
}

describe('planPause', () => {
  /**
   * **세대를 올리는 것이 살아남은 잡을 막는 장치다.** 큐를 따로 비우지 않는
   * 이유가 여기 있다 — `handleAction`의 `isStaleEpoch`가 이미 그 일을 한다.
   */
  it('세대를 올린다 — 없으면 1부터', () => {
    expect(planPause(stateOf({ timerEpoch: 7 }))?.epoch).toBe(8);
    expect(planPause(stateOf({ timerEpoch: undefined }))?.epoch).toBe(1);
  });

  /**
   * 차례가 없는 테이블에는 애초에 멈출 시계가 없다. 표시를 달면 딜러가 아무
   * 일도 없던 테이블에서 재개 버튼을 눌러야 한다.
   */
  it.each([
    ['쇼다운', { phase: GamePhase.SHOWDOWN }],
    ['차례 없음', { currentTurnSeatIndex: -1 }],
    ['그 자리에 사람이 없음', { currentTurnSeatIndex: 5 }],
  ])('%s이면 멈출 것이 없다', (_label, over) => {
    expect(planPause(stateOf(over))).toBeNull();
  });
});

/**
 * 재개 쪽 규칙은 여기 없다 — `PlaysyncService.scheduleTurnTimeout`이 평소
 * 경로와 같은 코드로 거므로, 그 자리를 검증하는 것은 통합 스펙의 몫이다.
 * 여기서 한 벌 더 재면 **두 벌째 시계**를 만들게 된다.
 */
