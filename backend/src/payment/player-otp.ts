import { randomInt } from 'node:crypto';

export const PLAYER_OTP_LENGTH = 8;

/**
 * 참가 OTP를 만든다. 참가자마다, 대회마다 다르다.
 *
 * **딜러 OTP(`src/dealer/dealer-otp.ts`)와 달리 해시하지 않는다.** 마이페이지에서
 * 언제든 다시 볼 수 있어야 하는 값이고, 권한이 자기 좌석 하나뿐이다. 근거는
 * `docs/superpowers/specs/2026-07-28-player-otp-design.md`에 있다.
 *
 * 딜러 OTP보다 두 자 길다. **시도 제한을 걸지 않기로 했기 때문**이다 — 대회
 * 단위 잠금은 그대로 DoS 원시함수라 대회 진행 자체를 멈춘다. 참가자 200명이면
 * 유효한 값이 200개이므로, 6자리는 적중 확률이 1/5,000이고 8자리는 1/500,000이다.
 *
 * `Math.random()`을 쓰지 않는 이유: 암호학적 난수가 아니라 출력 몇 개로 내부
 * 상태를 복원해 다음 값을 계산할 수 있다.
 *
 * `padStart`가 필요한 이유: `randomInt`가 주는 것은 숫자라 617이 "617"이 된다.
 * 그대로 두면 약 10%가 7자 이하로 나와 텍스트 공간이 명목값에 못 미친다 —
 * 위협 모델 관찰 3이 딜러 OTP에서 지적한 그 문제다.
 */
export function generatePlayerOtp(): string {
  return String(randomInt(0, 10 ** PLAYER_OTP_LENGTH)).padStart(PLAYER_OTP_LENGTH, '0');
}
