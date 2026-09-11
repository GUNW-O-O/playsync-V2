import * as bcrypt from 'bcrypt';
import { bcryptRounds, isWeakenedBcrypt } from './bcrypt-cost';

/**
 * 값을 읽는 규칙과, 그 값이 **실제 해시에 실리는가**를 나눠 본다.
 *
 * 앞쪽만 있으면 "숫자를 잘 파싱한다"까지밖에 증명이 안 된다. 이 노브의
 * 목적은 부하 무대에서 bcrypt 비용을 내리는 것이고, 그것이 되려면 값이
 * 해시 문자열의 코스트 자리에 들어가야 한다. 그래서 마지막 검사는 진짜로
 * 굽고 `$2b$04$`를 확인한다.
 */
describe('bcrypt 코스트', () => {
  it('미설정이면 제품 값 10이다', () => {
    expect(bcryptRounds({})).toBe(10);
  });

  it('무대가 준 값을 그대로 쓴다', () => {
    expect(bcryptRounds({ BCRYPT_ROUNDS: '4' })).toBe(4);
  });

  /**
   * 범위 밖은 기본값으로 되돌린다. bcrypt가 4~31만 받으므로 그 밖의 값은
   * **첫 회원가입에서** 던지는데, 그 자리는 원인처럼 보이지 않는다.
   *
   * 「그 밖」에 오타(`abc`)와 빈 문자열도 넣는다 — `Number('')`는 0이고
   * `Number('abc')`는 NaN이라, 한쪽만 막으면 다른 쪽이 샌다.
   */
  it.each([['3'], ['32'], ['0'], ['-1'], ['10.5'], ['abc'], ['']])(
    'BCRYPT_ROUNDS=%p는 범위 밖이라 10으로 되돌린다',
    (raw) => {
      expect(bcryptRounds({ BCRYPT_ROUNDS: raw })).toBe(10);
    },
  );

  /**
   * 범위 안의 큰 값은 되돌리지 않는다. 코스트를 올리는 것은 오타가 아니라
   * 정당한 보안 강화다 — 이 검사가 없으면 "안전한 쪽으로 전부 10으로"라는
   * 구현도 위 검사를 전부 통과한다.
   */
  it('제품 값보다 높은 값은 그대로 둔다', () => {
    expect(bcryptRounds({ BCRYPT_ROUNDS: '12' })).toBe(12);
  });

  it('제품 값보다 낮을 때만 약해진 것으로 본다', () => {
    const verdict = (raw?: string) => isWeakenedBcrypt(raw === undefined ? {} : { BCRYPT_ROUNDS: raw });
    expect(`${verdict('4')} ${verdict()} ${verdict('12')}`).toBe('true false false');
  });

  /**
   * **값이 해시에 실제로 실리는가.** bcrypt 해시는 자기 코스트를 문자열에
   * 싣고 다니고(`$2b$04$...`), `compare` 비용을 정하는 것이 이 자리다 —
   * 그래서 시드를 다시 깔지 않으면 로그인은 옛 코스트 그대로다.
   */
  it('구운 해시가 그 코스트를 싣고 나온다', async () => {
    const hash = await bcrypt.hash('pw', bcryptRounds({ BCRYPT_ROUNDS: '4' }));
    expect(hash.slice(0, 7)).toBe('$2b$04$');
    expect(await bcrypt.compare('pw', hash)).toBe(true);
  });
});
