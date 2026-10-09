/**
 * 재기동 뒤 기기 복귀 k/n(T96 · T117). 순수 함수 — 소켓도 Redis도 모른다.
 *
 * **필요한 기기는 앉은 사람이 있는 테이블마다 딜러 1 + 켜진 자리마다 좌석 1이다**(T117).
 * 딜러만 세던 동안 딜러가 좌석보다 먼저 돌아와 띠가 걷히고, 끊긴 태블릿의 파산자가
 * 리바인 시간초과로 탈락했다(1,000테이블 kill에서 111명).
 *
 * **present는 필요한 자리 안에서만 센다** — 빈 테이블의 딜러나 비트맵에서 빠진 자리의
 * 소켓이 k를 부풀리면 멈춘 자리가 남았는데 n/n이 된다.
 */
export type RequiredTable = { tableId: string; seats: number[] };
export type TablePresence = { dealer: boolean; seats: ReadonlySet<number> };
/** `seatIndex`가 `null`이면 그 테이블의 딜러다. */
export type MissingDevice = { tableId: string; seatIndex: number | null };

export function syncProgress(
  required: RequiredTable[],
  presence: ReadonlyMap<string, TablePresence>,
) {
  let present = 0;
  let total = 0;
  const missing: MissingDevice[] = [];
  for (const table of required) {
    const here = presence.get(table.tableId);
    total += 1 + table.seats.length;
    if (here?.dealer) present += 1;
    else missing.push({ tableId: table.tableId, seatIndex: null });
    for (const seat of table.seats) {
      if (here?.seats.has(seat)) present += 1;
      else missing.push({ tableId: table.tableId, seatIndex: seat });
    }
  }
  return { present, required: total, done: present === total, missing };
}
