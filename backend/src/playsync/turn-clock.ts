import { GamePhase, TableState } from 'src/game-engine/types';

/**
 * 턴 시계. **정지에서 돌아왔을 때 이 시계를 어떻게 다루나**가 여기 산다.
 *
 * 재시작이 차례였던 사람을 자동 폴드시키던 자리다(T94). 정지 동안 블라인드
 * 시계는 `RecoveryService`가 정지 시간만큼 밀어 주는데, **액션 시계는 아무도
 * 밀지 않았다.** 같은 정지를 한쪽만 보정하는 비대칭이 결함의 뿌리였다.
 *
 * 폴드되는 경로가 둘이고 서로 독립이라, 하나만 막으면 다른 하나가 같은 결과를
 * 낸다.
 *
 * | | 무엇이 폴드시키나 | 무엇으로 막나 |
 * |---|---|---|
 * | 잡 | 큐에 남은 타임아웃 잡이 부팅 직후 발화한다 | **세대를 올린다** — 살아남은 잡은 `isStaleEpoch`에 걸려 버려진다 |
 * | 마감 | 돌아온 사람이 누른 버튼이 마감을 지나 `TIME_OUT`으로 바뀐다 | **마감을 지운다** |
 *
 * 세대를 올리는 것이 큐를 비우는 것보다 나은 이유는, 그 장치가 **이미 그 일을
 * 하려고 있기 때문**이다(`PlaysyncService`의 `removeTimeoutJob` 주석 — "세대가
 * 다르면 잡이 스스로 폐기된다"). 큐를 따로 비우면 같은 목적의 장치가 둘이 된다.
 *
 * ## 정지의 끝을 시계가 정하지 않는다
 *
 * 처음(T94)에는 부팅에서 유예를 얹어 마감을 다시 찍었다. 그 유예는 **버튼이
 * 없어서 시계로 때운 값**이었다. T95가 딜러의 재개 명령을 만들면서 그 값이
 * 사라졌다 — 부팅은 정지의 끝이 아니고, 프로세스가 떠도 태블릿이 돌아와야 판이
 * 돈다. 자동으로 풀면 그 시각을 감으로 잡아야 하고, 짧으면 아직 깜깜한 사람이
 * 폴드당하고 길면 다 모인 테이블이 기다린다.
 *
 * **타이머 없는 테이블이 남는 것을 받아들인다.** 카드가 물리라 딜러가 없으면
 * 판은 어차피 안 나간다 — 소프트웨어 타이머가 대신할 수 있는 일이 아니다.
 */

/** 한 턴에 주어지는 시간. 잡의 delay와 `state.actionDeadline`이 같은 값을 써야 한다. */
export const TURN_TIMEOUT_MS = 30000;

type TurnView = Pick<TableState, 'phase' | 'currentTurnSeatIndex' | 'players' | 'timerEpoch'>;

/**
 * 차례가 살아 있나. `scheduleTimeout`의 판정과 **같은 모양이어야 한다** —
 * 한쪽만 고치면 복구가 평소 경로에 없는 타이머를 만들거나 있는 타이머를
 * 빠뜨린다.
 */
function turnOwner(state: TurnView) {
  if (state.phase === GamePhase.SHOWDOWN || state.currentTurnSeatIndex === -1) return null;
  return state.players[state.currentTurnSeatIndex] ?? null;
}

export interface PausePlan {
  /** 올린 세대. 살아남은 잡을 무효로 만드는 것이 이 값의 일이다. */
  epoch: number;
}

/**
 * 정지에서 돌아온 테이블을 **멈춘 채로 세운다.** 차례가 없으면 `null`.
 *
 * 차례가 없는 테이블(쇼다운·대기·빈 테이블)에 정지 표시를 달지 않는 이유는,
 * 그 자리에는 애초에 멈출 시계가 없기 때문이다. 달아 두면 딜러가 아무 일도
 * 없던 테이블에서 재개 버튼을 눌러야 한다.
 */
export function planPause(state: TurnView): PausePlan | null {
  if (!turnOwner(state)) return null;
  return { epoch: (state.timerEpoch ?? 0) + 1 };
}

/**
 * 재개는 여기 없다. 딜러가 다시 열 때 거는 타이머는
 * `PlaysyncService.scheduleTurnTimeout`이 이미 하는 일 그대로다 — 세대를
 * 올리고, 낡은 잡을 지우고, 마감을 찍는다. 여기 한 벌 더 쓰면 평소 경로와
 * 재개 경로가 서로 다른 시계를 갖게 된다.
 */
