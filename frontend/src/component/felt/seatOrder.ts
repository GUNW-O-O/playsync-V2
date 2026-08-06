/**
 * 좌석 인덱스를 화면에 그릴 순서로 준다.
 *
 * 테이블은 회전하지 않는다. 좌석 태블릿은 딜러가 위(건너편), 딜러 태블릿은
 * 딜러가 아래(자기 앞)라서 같은 테이블을 180° 돌린 것이 되고, **좌석 번호는
 * 그대로다.** 고개를 들면 진짜 테이블이 있으므로 화면이 눈과 어긋나는 순간
 * 그게 곧 오조작이다.
 */
export type FeltOrientation = 'player' | 'dealer';

const PLAYER_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export function seatOrder(orientation: FeltOrientation): number[] {
  return orientation === 'player' ? [...PLAYER_ORDER] : [...PLAYER_ORDER].reverse();
}
