import { syncProgress } from './sync-progress';

it('앉은 테이블 전부에 딜러가 있으면 done', () => {
  expect(syncProgress(['a', 'b'], ['a', 'b'])).toEqual({ present: 2, required: 2, done: true });
});
it('하나라도 없으면 아직이다', () => {
  expect(syncProgress(['a', 'b'], ['a'])).toEqual({ present: 1, required: 2, done: false });
});
/** **반대 입력.** 셈 밖 테이블의 딜러가 k를 부풀리면 안 된다. */
it('앉은 사람이 없는 테이블의 딜러는 세지 않는다', () => {
  expect(syncProgress(['a'], ['a', 'z'])).toEqual({ present: 1, required: 1, done: true });
  expect(syncProgress(['a', 'b'], ['a', 'z'])).toEqual({ present: 1, required: 2, done: false });
});
it('한 테이블에 딜러 소켓이 둘이어도 한 번 센다', () => {
  expect(syncProgress(['a', 'b'], ['a', 'a'])).toEqual({ present: 1, required: 2, done: false });
});
it('앉은 테이블이 없으면 done', () => {
  expect(syncProgress([], [])).toEqual({ present: 0, required: 0, done: true });
});
