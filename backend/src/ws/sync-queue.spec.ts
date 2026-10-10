import { SyncQueue, syncRecountHoldMs, dealerGoneGraceMs } from './sync-queue';

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
  const HOLD = 60;
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('보류 동안 들어온 요청은 하나로 합친다', async () => {
    const calls: string[][] = [];
    const q = new SyncQueue<string>(async (_k, joiners) => { calls.push([...joiners]); }, () => {}, HOLD);

    const waits = [q.recountLater('t', 'a')];
    await jest.advanceTimersByTimeAsync(HOLD / 4);
    waits.push(q.recountLater('t'));
    await jest.advanceTimersByTimeAsync(HOLD / 4);
    waits.push(q.recountLater('t', 'b'));
    await jest.advanceTimersByTimeAsync(HOLD / 4);
    expect(calls).toEqual([]);

    await jest.advanceTimersByTimeAsync(HOLD);
    await Promise.all(waits);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('보류가 끝나면 시작하고, 그 뒤 요청은 새로 줄 선다', async () => {
    const calls: string[][] = [];
    const order: string[] = [];
    const g = gate();
    const q = new SyncQueue<string>(async (_k, joiners) => {
      calls.push([...joiners]);
      order.push('recount');
      if (calls.length === 1) await g.shut;
    }, () => {}, HOLD);

    const first = q.recountLater('t', 'a');
    const later = q.enqueue('t', async () => { order.push('enqueue'); });
    await jest.advanceTimersByTimeAsync(HOLD);
    expect(calls).toEqual([['a']]); // 보류가 끝나 시작했고 아직 달리는 중

    const second = q.recountLater('t', 'b'); // 달리는 중에 온 요청
    g.open();
    await jest.advanceTimersByTimeAsync(HOLD);
    await Promise.all([first, later, second]);

    expect(calls).toEqual([['a'], ['b']]);
    expect(order).toEqual(['recount', 'enqueue', 'recount']);
  });

  /**
   * 보류는 재접속 몰림을 합치려는 것이지 급한 일을 세워 두려는 것이 아니다(T121). 회선이
   * 끊겨 대회를 멈추는 일이 보류 뒤에 서면 그 1초 동안 타임아웃이 사람을 접는다 —
   * 200테이블 실측에서 끊김마다 2~6명이었다. **순서는 그대로고 기다림만 없앤다.**
   */
  it('enqueue가 오면 보류를 끝내고 곧바로 재집계 → 그 일 순서로 돈다', async () => {
    const order: string[] = [];
    const q = new SyncQueue<string>(async () => { order.push('recount'); }, () => {}, HOLD);

    const held = q.recountLater('t');
    const urgent = q.enqueue('t', async () => { order.push('enqueue'); });
    await jest.advanceTimersByTimeAsync(0); // 시간은 안 흘렀다
    await Promise.all([held, urgent]);

    expect(order).toEqual(['recount', 'enqueue']);
  });

  it('앞의 일이 아직 달리는 중에 온 enqueue도 그 뒤의 보류를 없앤다', async () => {
    const order: string[] = [];
    const g = gate();
    const q = new SyncQueue<string>(async () => { order.push('recount'); }, () => {}, HOLD);

    const head = q.enqueue('t', () => g.shut);
    const held = q.recountLater('t');
    const urgent = q.enqueue('t', async () => { order.push('enqueue'); });
    g.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([head, held, urgent]);

    expect(order).toEqual(['recount', 'enqueue']);
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
    for (const v of ['abc', '-5', '1.5', ' ', '1e3', '0x10', ' 5 ']) expect(hold(v)).toBe(1000);
  });
});

describe('dealerGoneGraceMs', () => {
  const grace = (v: string | undefined) => dealerGoneGraceMs({ DEALER_GONE_GRACE_MS: v });
  it('기본 10초, 음이 아닌 정수는 그대로, 그 밖은 기본값', () => {
    expect(`${dealerGoneGraceMs({})} ${grace('')} ${grace('0')} ${grace('250')} ${grace('-5')} ${grace('abc')}`)
      .toBe('10000 10000 0 250 10000 10000');
  });
});
