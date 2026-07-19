export interface RetryOptions {
  /** 총 시도 횟수. 첫 시도를 포함한다. */
  attempts: number;
  /** 첫 재시도까지의 기준 대기. 이후 2배씩 늘어난다. */
  baseMs: number;
  /** 대기 상한. 지수 증가가 무한정 커지지 않게 한다. */
  maxMs?: number;
  /** 재시도 직전에 불린다. (몇 번째 재시도인지, 얼마나 기다릴지) */
  onRetry?: (attempt: number, delayMs: number) => void | Promise<void>;
  /**
   * 시간과 난수를 주입받는 이유.
   *
   * 실제로 기다리면 테스트가 느려지고, jest 가짜 타이머는 await가 끼면
   * 다루기 까다롭다. 검증하고 싶은 것은 "얼마나 오래"가 아니라 "간격이
   * 지수적으로 늘고 지터로 흩어지는가"라는 규칙이므로, 그 규칙만 관찰할 수
   * 있게 두 가지를 밖에서 넣는다. 기본값이 프로덕션 동작이다.
   */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type RetryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 실패하면 지수 백오프 + 풀 지터로 다시 시도한다.
 *
 * throw하지 않고 결과를 값으로 돌려준다 — 호출자가 "실패했다"를 상태로
 * 바꿔 전파해야 하는 경우가 있어서다. 실패를 예외로만 표현하면 그 경로에서
 * 상태를 남기기 위해 다시 try/catch로 감싸야 한다.
 *
 * **지터가 핵심이다.** DB 장애는 여러 테이블을 한꺼번에 실패시킨다. 간격이
 * 고정이면 전부 같은 순간에 재시도해서 이미 힘든 DB를 동기화된 파도로 때린다.
 * 재시도가 장애를 키우는 전형이라, 상한 안에서 시각을 무작위로 흩는다.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const {
    attempts,
    baseMs,
    maxMs = Number.POSITIVE_INFINITY,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      lastError = error;
    }

    // 마지막 시도 뒤에는 기다리지 않는다. 기다려도 시도할 것이 없다.
    if (attempt === attempts - 1) break;

    const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
    const delayMs = random() * ceiling;
    await onRetry?.(attempt + 1, delayMs);
    await sleep(delayMs);
  }

  return { ok: false, error: lastError };
}
