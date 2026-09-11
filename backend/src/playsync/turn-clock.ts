import { GamePhase, TableState } from 'src/game-engine/types';

/**
 * 턴 시계. **정지에서 돌아왔을 때 이 시계를 어떻게 다시 세우나**가 여기 산다.
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
 * | 마감 | 돌아온 사람이 누른 버튼이 마감을 지나 `TIME_OUT`으로 바뀐다 | **마감을 다시 찍는다** |
 *
 * 세대를 올리는 것이 큐를 비우는 것보다 나은 이유는, 그 장치가 **이미 그 일을
 * 하려고 있기 때문**이다(`PlaysyncService`의 `removeTimeoutJob` 주석 — "세대가
 * 다르면 잡이 스스로 폐기된다"). 큐를 따로 비우면 같은 목적의 장치가 둘이 된다.
 */

/** 한 턴에 주어지는 시간. 잡의 delay와 `state.actionDeadline`이 같은 값을 써야 한다. */
export const TURN_TIMEOUT_MS = 30000;

/**
 * 재개 유예의 기본값.
 *
 * **남은 시간을 복원하려 들지 않는다.** 하트비트가 30초 주기라 "언제 죽었나"의
 * 해상도가 그만큼이고, 그 오차로 남은 시간을 계산하면 사람마다 최대 30초씩
 * 틀린다. 대신 **턴을 통째로 다시 준다** — 틀리는 방향이 한쪽(사람에게 유리)
 * 으로 고정되고, 그 방향이면 아무도 돈을 잃지 않는다.
 *
 * 유예가 따로 필요한 이유는 부팅이 정지의 끝이 아니기 때문이다. 프로세스가
 * 떠도 단말이 돌아와야 판이 돈다. 실측으로 660소켓이 제품 기본 상한에서 전부
 * 돌아오는 데 **31.9초**였다(`docs/results/`의 재접속 실측). 사람이 태블릿을
 * 집어 드는 시간은 그 위에 얹힌다. 60초는 그 실측의 두 배다.
 *
 * **이 값이 임시라는 것을 적어 둔다.** 정지의 진짜 끝은 시계가 아니라 딜러가
 * 이어서 진행을 누르는 순간이고, 그 버튼은 T95가 만든다. 그때 이 유예는
 * 버튼이 올 때까지의 상한으로 물러난다.
 */
const DEFAULT_RESUME_GRACE_MS = 60_000;

/** 호출 시점에 읽는다 — 고정하면 통합 테스트가 60초를 실제로 기다려야 한다. */
export function resumeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RESUME_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESUME_GRACE_MS;
  const n = Number(raw);
  // 음수나 오타를 기본값으로 되돌린다. 0은 허용한다 — 유예 없이 재는 실행이
  // 있을 수 있고, 그건 오타가 아니라 고른 값이다.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RESUME_GRACE_MS;
  return n;
}

export interface ResumePlan {
  /** 새 마감 시각. 잡의 delay도 이 값에서 나와야 한다. */
  deadline: number;
  /** 올린 세대. 살아남은 잡을 무효로 만드는 것이 이 값의 일이다. */
  epoch: number;
  /** 이 턴의 주인. 새 잡이 이 사람을 가리켜야 한다. */
  userId: string;
}

/**
 * 정지에서 돌아온 테이블의 턴 시계를 다시 세울 계획. **차례가 없으면 `null`.**
 *
 * 차례가 없는 테이블(쇼다운·대기·빈 테이블)에 손대지 않는 이유는, 그 자리에
 * 마감을 찍으면 **없던 타이머가 생기기** 때문이다. `scheduleTimeout`이 같은
 * 조건으로 잡을 안 거는 것과 짝이다.
 */
export function planResume(
  state: Pick<TableState, 'phase' | 'currentTurnSeatIndex' | 'players' | 'timerEpoch'>,
  now: number,
  graceMs: number,
): ResumePlan | null {
  // `scheduleTimeout`의 판정과 같은 모양이어야 한다. 한쪽만 고치면 복구가
  // 평소 경로에 없는 타이머를 만들거나 있는 타이머를 빠뜨린다.
  if (state.phase === GamePhase.SHOWDOWN || state.currentTurnSeatIndex === -1) return null;

  const player = state.players[state.currentTurnSeatIndex];
  if (!player) return null;

  return {
    deadline: now + graceMs + TURN_TIMEOUT_MS,
    epoch: (state.timerEpoch ?? 0) + 1,
    userId: player.id,
  };
}
