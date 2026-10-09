import { batched } from './batched';

/**
 * T119 — 같은 순간에 몰린 조회를 쿼리 하나로 묶는다.
 *
 * 재기동 뒤 재접속에서 기기마다 같은 조회(좌석 토큰 세대)를 세 번씩 했고,
 * 667테이블 kill에서 pg 풀 대기가 1,246까지 찼다.
 */
describe('batched', () => {
  function latch() {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    return { open, opened };
  }

  it('한가할 때는 기다리지 않고 혼자 나간다', async () => {
    const calls: string[][] = [];
    const get = batched<string, string>(async (keys) => { calls.push(keys); return keys.map((k) => k.toUpperCase()); });

    expect(await get('a')).toBe('A');

    expect(calls).toEqual([['a']]);
  });

  it('앞의 조회가 도는 동안 온 것들은 다음 한 번에 묶인다', async () => {
    const calls: string[][] = [];
    const gate = latch();
    const get = batched<string, string>(async (keys) => {
      calls.push(keys);
      if (calls.length === 1) await gate.opened;
      return keys.map((k) => k.toUpperCase());
    });

    const first = get('a');
    const rest = [get('b'), get('c'), get('d')];
    gate.open();

    expect(await Promise.all([first, ...rest])).toEqual(['A', 'B', 'C', 'D']);
    expect(calls).toEqual([['a'], ['b', 'c', 'd']]);
  });

  /**
   * **돌고 있는 조회의 결과를 나중에 온 요청에 주지 않는다.** 그 조회는 요청보다
   * 먼저 시작했으므로 요청 직전에 바뀐 값을 못 본다 — 세대를 올린 직후의 확인이
   * 낡은 세대를 받아 폐기된 좌석을 통과시킨다.
   */
  it('같은 키라도 도는 조회에 얹히지 않는다 — 요청 뒤에 시작한 조회의 값을 받는다', async () => {
    let version = 1;
    const gate = latch();
    let loads = 0;
    const get = batched<string, number>(async (keys) => {
      const seen = version;
      if (++loads === 1) await gate.opened;
      return keys.map(() => seen);
    });

    const early = get('seat');
    version = 2;
    const late = get('seat');
    gate.open();

    expect(`${await early} ${await late} 조회 ${loads}`).toBe('1 2 조회 2');
  });

  it('조회가 던지면 그 묶음만 던지고, 다음 묶음은 돈다', async () => {
    let loads = 0;
    const get = batched<string, string>(async (keys) => {
      if (++loads === 1) throw new Error('풀 고갈');
      return keys;
    });

    await expect(get('a')).rejects.toThrow('풀 고갈');
    expect(await get('b')).toBe('b');
  });
});
