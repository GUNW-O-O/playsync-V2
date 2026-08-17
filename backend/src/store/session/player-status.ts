import { PlayerStatus } from '@prisma/client';

/**
 * 참가자 상태를 묶어서 판정한다. `tournament-status.ts`와 같은 이유로 한
 * 곳에 모은다 — **상태를 나열해서 고르는 코드가 흩어지면, 상태가 하나 늘 때
 * 조용히 빠진다.** 이 리포는 `SYNCING`으로 한 번, 그리고 여기 `RELEASED`로
 * 또 한 번 그 자리에 섰다.
 */

/**
 * 끝난 참가. **배제 목록으로 적는 쪽이 안전하다** — 새 상태가 생기면 기본이
 * "아직 안 끝났다"가 되어야 상금·재입장 경로가 사람을 잃지 않는다.
 */
export const FINISHED_PLAYER_STATUSES = [
  PlayerStatus.ELIMINATED,
  PlayerStatus.AWARDED,
] as const;

/**
 * **인원수에 잡히는 상태.** `Tournament.activePlayers`가 세는 집합이고,
 * 최후 1인 판정도 이것을 본다.
 *
 * `WAITING`이 빠져 있는 것이 핵심이다. 결제만 하고 한 번도 안 앉은 사람
 * (노쇼)은 살아 있던 적이 없다 — 결제한 사람 수는 `totalPlayers`가 따로 든다.
 * `RELEASED`가 들어 있는 것도 같은 이유다. 상점이 좌석을 뗀 사람(T29)은 칩을
 * 들고 있고 다시 앉을 수 있으므로 **여전히 대회에 있는 사람**이다.
 */
export const LIVE_PLAYER_STATUSES = [
  PlayerStatus.PLAYING,
  PlayerStatus.RELEASED,
] as const;

/** 아직 끝나지 않은 참가인가. 재입장·상금 지급이 이 판정을 쓴다. */
export function isFinishedParticipant(status: PlayerStatus): boolean {
  return (FINISHED_PLAYER_STATUSES as readonly PlayerStatus[]).includes(status);
}

/** 지금 이 대회에 살아 있는 사람인가. 인원수가 세는 집합이다. */
export function isLiveParticipant(status: PlayerStatus): boolean {
  return (LIVE_PLAYER_STATUSES as readonly PlayerStatus[]).includes(status);
}
