/**
 * 밀리초를 사람이 읽는 길이로. 「3분 12초」.
 *
 * 정지 안내가 쓰는 유일한 자리다(T95). 숫자를 그대로 보여 주면 딜러가 머릿속
 * 나눗셈을 해야 하는데, 그 화면은 테이블 앞에서 몇 초 안에 읽히는 화면이다.
 *
 * **반올림하지 않고 버린다.** 「3분」으로 반올림된 2분 40초는 실제보다 길게
 * 들리고, 이 값이 쓰이는 자리가 "얼마나 놓쳤나"라 짧게 말하는 쪽이 안전하다.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  // 1분 미만은 분을 적지 않는다. 「0분 7초」는 읽는 사람을 한 번 멈춰 세운다.
  if (minutes === 0) return `${seconds}초`;
  // 정확히 분 단위면 초를 적지 않는다 — 「3분 0초」도 같은 이유다.
  if (seconds === 0) return `${minutes}분`;
  return `${minutes}분 ${seconds}초`;
}
