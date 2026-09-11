import { GamePhase, TableState } from 'src/game-engine/types';
import { TURN_TIMEOUT_MS, planResume, resumeGraceMs } from './turn-clock';

/**
 * 정지에서 돌아온 뒤 턴 시계를 다시 세우는 규칙(T94).
 *
 * **어느 기본값과도 겹치지 않는 숫자를 먹인다.** 유예 기본값이 60000이고 턴이
 * 30000이라, 유예로 30000을 주면 "유예를 더했다"와 "턴만 더했다"가 같은 답을
 * 낸다 — 한쪽을 지워도 초록인 상태다(T29에서 데인 자리).
 */
const GRACE = 7000;
const NOW = 1_000;

function stateOf(over: Partial<TableState> = {}): TableState {
  return {
    phase: GamePhase.PRE_FLOP,
    currentTurnSeatIndex: 1,
    players: [
      { id: 'seat-0' },
      { id: 'seat-1' },
    ],
    ...over,
  } as unknown as TableState;
}

describe('planResume', () => {
  it('유예와 턴을 **둘 다** 더한 마감을 낸다', () => {
    // 1000 + 7000 + 30000. 셋 중 하나라도 빠지면 숫자가 달라진다.
    expect(planResume(stateOf(), NOW, GRACE)?.deadline).toBe(NOW + GRACE + TURN_TIMEOUT_MS);
  });

  /**
   * **세대를 올리는 것이 살아남은 잡을 막는 장치다.** 큐를 따로 비우지 않는
   * 이유가 여기 있다 — `handleAction`의 `isStaleEpoch`가 이미 그 일을 한다.
   */
  it('세대를 올린다 — 없으면 1부터', () => {
    expect(planResume(stateOf({ timerEpoch: 7 }), NOW, GRACE)?.epoch).toBe(8);
    expect(planResume(stateOf({ timerEpoch: undefined }), NOW, GRACE)?.epoch).toBe(1);
  });

  it('차례의 주인을 함께 낸다 — 새 잡이 가리킬 사람이다', () => {
    expect(planResume(stateOf({ currentTurnSeatIndex: 0 }), NOW, GRACE)?.userId).toBe('seat-0');
  });

  /**
   * **차례가 없는 테이블에 손대면 없던 타이머가 생긴다.** `scheduleTimeout`이
   * 같은 조건으로 잡을 안 거는 것과 짝이라, 한쪽만 고치면 복구가 평소 경로에
   * 없는 타이머를 만든다.
   */
  it.each([
    ['쇼다운', { phase: GamePhase.SHOWDOWN }],
    ['차례 없음', { currentTurnSeatIndex: -1 }],
    ['그 자리에 사람이 없음', { currentTurnSeatIndex: 5 }],
  ])('%s이면 계획이 없다', (_label, over) => {
    expect(planResume(stateOf(over), NOW, GRACE)).toBeNull();
  });
});

describe('resumeGraceMs', () => {
  it('미설정이면 기본값이다', () => {
    expect(resumeGraceMs({})).toBe(60_000);
  });

  it('무대가 준 값을 그대로 쓴다', () => {
    expect(resumeGraceMs({ RESUME_GRACE_MS: '7000' })).toBe(7000);
  });

  /**
   * **0은 오타가 아니라 고른 값이다.** 유예 없이 재는 실행이 있을 수 있다.
   * `Number(raw) || 기본값`으로 쓰면 0이 falsy라 조용히 기본값으로 돌아간다.
   */
  it('0을 허락한다', () => {
    expect(resumeGraceMs({ RESUME_GRACE_MS: '0' })).toBe(0);
  });

  it.each([['-1'], ['abc'], ['']])('%p는 읽을 수 없어 기본값으로 되돌린다', (raw) => {
    expect(resumeGraceMs({ RESUME_GRACE_MS: raw })).toBe(60_000);
  });
});
