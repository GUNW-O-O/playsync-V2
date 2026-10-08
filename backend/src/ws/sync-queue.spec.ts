import { SyncQueue, syncRecountHoldMs } from './sync-queue';

/** 테스트가 직접 여는 문. 열기 전까지 그 일은 끝나지 않는다. */
function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((r) => { open = r; });
  return { shut, open };
}

describe('SyncQueue', () => {
  /** **몇 번 돌았나를 센다** — 값만 보면 「안 돌았다」와 「돌았는데 같다」를 못 가른다. */
  it('기다리는 재집계가 있으면 새로 세우지 않고 합친다', async () => {
    const calls: string[][] = [];
    const q = new SyncQueue<string>(async (_k, joiners) => { calls.push([...joiners]); }, () => {});
    const g = gate();
    const head = q.enqueue('t', () => g.shut);

    const waits = [q.recountLater('t', 'a'), q.recountLater('t'), q.recountLater('t', 'b')];
    g.open();
    await head;
    await Promise.all(waits);

    expect(calls).toEqual([['a', 'b']]);
  });

  it('달리는 중에 부르면 그 뒤에 한 번 더 돈다', async () => {
    const g = gate();
    let runs = 0;
    const q = new SyncQueue<string>(async () => { runs += 1; if (runs === 1) await g.shut; }, () => {});

    const first = q.recountLater('t');
    await new Promise((r) => setImmediate(r));
    const second = q.recountLater('t');
    g.open();
    await Promise.all([first, second]);

    expect(runs).toBe(2);
  });

  it('enqueue는 합치지 않고 순서대로 돈다', async () => {
    const order: string[] = [];
    const q = new SyncQueue<string>(async () => { order.push('recount'); }, () => {});
    await Promise.all([
      q.enqueue('t', async () => { order.push('force-1'); }),
      q.recountLater('t'),
      q.enqueue('t', async () => { order.push('force-2'); }),
    ]);
    expect(order).toEqual(['force-1', 'recount', 'force-2']);
  });

  it('대회가 다르면 서로 기다리지 않는다', async () => {
    const g = gate();
    const seen: string[] = [];
    const q = new SyncQueue<string>(async (k) => { seen.push(k); }, () => {});
    const blocked = q.enqueue('a', () => g.shut);
    await q.recountLater('b');
    expect(seen).toEqual(['b']);
    g.open();
    await blocked;
  });

  it('재집계가 던지면 onError로 보내고 줄은 계속 돈다', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const q = new SyncQueue<string>(async () => { runs += 1; if (runs === 1) throw new Error('boom'); }, (e) => errors.push(e));
    await q.recountLater('t');
    await q.recountLater('t');
    expect(`${runs} ${errors.length}`).toBe('2 1');
  });

  it('enqueue의 거부는 호출자에게 간다', async () => {
    const q = new SyncQueue<string>(async () => {}, () => {});
    await expect(q.enqueue('t', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await q.recountLater('t'); // 줄이 끊기지 않았다
  });

  /** 안 지우면 맵이 대회 수만큼 서버 수명 내내 는다. */
  it('다 끝나면 맵을 비운다', async () => {
    const q = new SyncQueue<string>(async () => {}, () => {});
    await Promise.all([q.recountLater('t', 'a'), q.enqueue('t', async () => 1)]);
    await new Promise((r) => setImmediate(r));
    expect(`${(q as any).chains.size} ${(q as any).waiting.size}`).toBe('0 0');
  });
});

describe('SyncQueue 보류 창', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const HOLD = 60;

  it('보류 동안 들어온 요청은 하나로 합친다', async () => {
    const calls: string[][] = [];
    const q = new SyncQueue<string>(async (_k, joiners) => { calls.push([...joiners]); }, () => {}, HOLD);

    const waits = [q.recountLater('t', 'a')];
    await sleep(HOLD / 4);
    waits.push(q.recountLater('t'));
    await sleep(HOLD / 4);
    waits.push(q.recountLater('t', 'b'));
    expect(calls).toEqual([]);
    await Promise.all(waits);

    expect(calls).toEqual([['a', 'b']]);
  });

  it('보류가 끝나면 시작하고, 그 뒤 요청은 새로 줄 선다', async () => {
    const calls: string[][] = [];
    const q = new SyncQueue<string>(async (_k, joiners) => { calls.push([...joiners]); }, () => {}, HOLD);

    await q.recountLater('t', 'a');
    await q.recountLater('t', 'b');

    expect(calls).toEqual([['a'], ['b']]);
  });
});

describe('syncRecountHoldMs', () => {
  const hold = (v: string | undefined) => syncRecountHoldMs({ SYNC_RECOUNT_HOLD_MS: v });
  it('미설정과 빈 문자열은 기본 1000', () => {
    expect(syncRecountHoldMs({})).toBe(1000);
    expect(hold('')).toBe(1000);
  });
  it('음이 아닌 정수는 그대로(0 포함)', () => {
    expect(hold('0')).toBe(0);
    expect(hold('250')).toBe(250);
  });
  it('그 밖은 기본값', () => {
    for (const v of ['abc', '-5', '1.5']) expect(hold(v)).toBe(1000);
  });
});
