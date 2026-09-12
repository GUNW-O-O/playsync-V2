/**
 * 딜러 복귀 k/n(T96). 순수 함수 — 소켓도 Redis도 모른다.
 *
 * **n은 앉은 사람이 있는 테이블이다.** 빈 테이블에는 딜러가 없을 수 있어, 넣으면
 * 영영 안 찬다. **k는 그 n 안에서만 센다** — 빈 테이블의 딜러가 k를 부풀리면
 * 멈춘 테이블이 남았는데 n/n이 된다.
 */
export function syncProgress(required: string[], dealerTables: Iterable<string>) {
  const need = new Set(required);
  const present = new Set([...dealerTables].filter((id) => need.has(id))).size;
  return { present, required: need.size, done: present === need.size };
}
