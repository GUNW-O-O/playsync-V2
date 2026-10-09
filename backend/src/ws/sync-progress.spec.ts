import { syncProgress, TablePresence } from './sync-progress';

function at(dealer: boolean, seats: number[]): TablePresence {
  return { dealer, seats: new Set(seats) };
}

it('딜러와 좌석이 다 있으면 done', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0, 1] }],
    new Map([['a', at(true, [0, 1])]]),
  );
  expect(r).toEqual({ present: 3, required: 3, done: true, missing: [] });
});

/** T117. 딜러가 다 와도 좌석 하나가 없으면 아직이다 — 옛 판정은 여기서 done이었다. */
it('딜러가 다 와도 좌석 하나가 없으면 아직이다', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0, 1] }, { tableId: 'b', seats: [4] }],
    new Map([['a', at(true, [0])], ['b', at(true, [4])]]),
  );
  expect(r).toEqual({ present: 4, required: 5, done: false, missing: [{ tableId: 'a', seatIndex: 1 }] });
});

it('딜러가 없으면 딜러가 빠진 자리로 나온다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [2] }], new Map([['a', at(false, [2])]]));
  expect(r).toEqual({ present: 1, required: 2, done: false, missing: [{ tableId: 'a', seatIndex: null }] });
});

/** **반대 입력.** 비트맵에 없는 자리(탈락 · 해제된 사람)의 소켓은 present를 부풀리지 않는다. */
it('필요 없는 자리의 소켓은 세지 않는다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [0] }], new Map([['a', at(true, [0, 5, 7])]]));
  expect(r).toEqual({ present: 2, required: 2, done: true, missing: [] });
});

it('필요 없는 테이블의 소켓은 세지 않는다', () => {
  const r = syncProgress(
    [{ tableId: 'a', seats: [0] }],
    new Map([['a', at(false, [])], ['z', at(true, [0])]]),
  );
  expect(r.present).toBe(0);
  expect(r.done).toBe(false);
});

it('소켓이 하나도 없는 테이블은 전부 빠진 자리다', () => {
  const r = syncProgress([{ tableId: 'a', seats: [3] }], new Map());
  expect(r).toEqual({
    present: 0, required: 2, done: false,
    missing: [{ tableId: 'a', seatIndex: null }, { tableId: 'a', seatIndex: 3 }],
  });
});

it('앉은 테이블이 없으면 done', () => {
  expect(syncProgress([], new Map())).toEqual({ present: 0, required: 0, done: true, missing: [] });
});
