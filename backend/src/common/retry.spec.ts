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
  // T62. 머리말의 "throw하지 않고 결과를 값으로 돌려준다"가 `fn` 밖에서는
  // 거짓이었다. `checkpointTableToDb`의 onRetry는 Redis 락을 잡으므로 DB가
  // 흔들리는 그 순간에 함께 던질 수 있고, 그러면 호출자는 `false`가 아니라
  // 예외를 받아 실패 표시를 남기지 못한 채 테이블이 갇혔다.
  it('onRetry가 던져도 예외가 새지 않는다', async () => {
    const { sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new Error('x'));
    const onRetry = jest.fn().mockRejectedValue(new Error('락 획득 실패'));

    const result = await retryAsync(fn, { attempts: 3, baseMs: 100, sleep, onRetry });

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('onRetry가 던져도 백오프는 유지된다', async () => {
    // 알림과 대기를 한 try로 묶으면 알림이 던진 순간 대기가 통째로 사라진다.
    // 그러면 장애 중에 간격 없이 재시도해서, 이 파일이 지터로 막으려 한
    // 동기화된 파도를 스스로 만든다.
    const { delays, sleep } = recorder();
    const fn = jest.fn().mockRejectedValue(new Error('x'));
    const onRetry = jest.fn().mockRejectedValue(new Error('락 획득 실패'));

    await retryAsync(fn, { attempts: 3, baseMs: 100, sleep, random: () => 1, onRetry });

    expect(delays).toEqual([100, 200]);
  });

  it('sleep이 던져도 예외가 새지 않는다', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('x'));
    const sleep = jest.fn().mockRejectedValue(new Error('타이머 실패'));

    const result = await retryAsync(fn, { attempts: 3, baseMs: 100, sleep });

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
