/**
 * 같은 순간에 몰린 조회를 한 번으로 묶는다(T119).
 *
 * **앞의 조회가 도는 동안 온 것들이 다음 한 번이 된다.** 한가할 때는 묶을 것이 없어
 * 혼자 바로 나가고, 몰릴수록 묶음이 커진다 — 타이머도 묶음 크기도 정하지 않는다.
 * 재기동 뒤 재접속에서 기기마다 같은 조회를 세 번씩 해, 667테이블 kill에서 pg 풀
 * 대기가 1,246까지 찼다.
 *
 * **도는 조회에 나중 요청을 얹지 않는다.** 그 조회는 요청보다 먼저 시작해 직전에
 * 바뀐 값을 못 본다. 요청은 언제나 자기보다 **뒤에** 시작한 조회의 값을 받는다 —
 * 묶지 않았을 때와 같은 보장이다.
 *
 * @param load 키 여럿을 받아 **같은 순서로** 값을 돌려준다.
 */
export function batched<K, V>(load: (keys: K[]) => Promise<V[]>): (key: K) => Promise<V> {
  type Waiter = { key: K; resolve: (value: V) => void; reject: (error: unknown) => void };
  let waiting: Waiter[] = [];
  let running = false;

  async function drain() {
    running = true;
    while (waiting.length > 0) {
      const batch = waiting;
      waiting = [];
      try {
        const values = await load(batch.map((w) => w.key));
        batch.forEach((w, i) => w.resolve(values[i]));
      } catch (error) {
        for (const w of batch) w.reject(error);
      }
    }
    running = false;
  }

  return (key) => new Promise<V>((resolve, reject) => {
    waiting.push({ key, resolve, reject });
    if (!running) void drain();
  });
}
