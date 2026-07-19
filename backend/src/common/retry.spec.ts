import { retryAsync } from './retry';

describe('retryAsync', () => {
  /** 실제로 기다리지 않는다. 검증 대상은 시간의 길이가 아니라 간격의 규칙이다. */
  function recorder() {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  it('첫 시도가 성공하면 재시도하지 않는다', async () => {
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await retryAsync(fn, { attempts: 5, baseMs: 100, sleep });

    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('중간에 성공하면 거기서 멈춘다', async () => {
    const { sleep } = recorder();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValue('ok');

    const result = await retryAsync(fn, { attempts: 5, baseMs: 100, sleep });

    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('전부 실패하면 마지막 에러를 돌려준다', async () => {
    const { sleep } = recorder();
    const last = new Error('last');
    const fn = jest.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValue(last);

    const result = await retryAsync(fn, { attempts: 3, baseMs: 100, sleep });

    expect(result).toEqual({ ok: false, error: last });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('대기 시간이 지수적으로 늘어난다', async () => {
    // random을 1로 고정하면 지터가 상한을 그대로 쓰므로 증가 규칙만 남는다.
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new Error('x'));

    await retryAsync(fn, { attempts: 4, baseMs: 100, sleep, random: () => 1 });

    // 마지막 시도 뒤에는 기다리지 않는다.
    expect(delays).toEqual([100, 200, 400]);
  });

  it('상한을 넘지 않는다', async () => {
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new Error('x'));

    await retryAsync(fn, { attempts: 5, baseMs: 100, maxMs: 250, sleep, random: () => 1 });

    expect(delays).toEqual([100, 200, 250, 250]);
  });

  it('지터가 붙어 같은 실패라도 대기 시간이 흩어진다', async () => {
    // DB 장애는 여러 테이블을 한꺼번에 실패시킨다. 간격이 고정이면 전부 같은
    // 순간에 재시도해서 이미 힘든 DB를 동기화된 파도로 때린다.
    const a = recorder();
    const b = recorder();
    const fn = jest.fn().mockRejectedValue(new Error('x'));

    await retryAsync(fn, { attempts: 3, baseMs: 1000, sleep: a.sleep, random: () => 0.1 });
    await retryAsync(fn, { attempts: 3, baseMs: 1000, sleep: b.sleep, random: () => 0.9 });

    expect(a.delays).not.toEqual(b.delays);
    // 풀 지터: 0 이상 상한 이하의 어딘가.
    expect(a.delays[0]).toBeLessThan(b.delays[0]);
    expect(a.delays[0]).toBeGreaterThanOrEqual(0);
    expect(b.delays[0]).toBeLessThanOrEqual(1000);
  });

  it('재시도할 때마다 알린다', async () => {
    const { sleep } = recorder();
    const onRetry = jest.fn();
    const fn = jest.fn().mockRejectedValue(new Error('x'));

    await retryAsync(fn, { attempts: 3, baseMs: 100, sleep, random: () => 1, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 200);
  });
});
