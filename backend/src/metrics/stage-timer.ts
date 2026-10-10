import { monitorEventLoopDelay } from 'perf_hooks';
import { Session } from 'inspector';
import { writeFileSync } from 'fs';

/**
 * 구간 계측(T119). **`LOAD_METRICS=1`일 때만 돈다** — 아니면 전부 통과만 한다.
 *
 * kill 뒤에는 k6 모니터 VU가 죽어 `/internal/metrics`를 긁는 쪽이 없다. 그래서
 * 긁히기를 기다리지 않고 창(5초)마다 한 줄을 로그로 낸다 — `docker logs`에서
 * `[stage]`로 걸러 읽는다. 구간마다 건수 · 합 · 최대(ms)다.
 */
const ON = process.env.LOAD_METRICS === '1';
const WINDOW_MS = 5000;

type Stat = { n: number; sum: number; max: number };
const stats = new Map<string, Stat>();
const gauges = new Map<string, () => Record<string, number>>();

function record(label: string, ms: number) {
  const s = stats.get(label) ?? { n: 0, sum: 0, max: 0 };
  s.n += 1;
  s.sum += ms;
  if (ms > s.max) s.max = ms;
  stats.set(label, s);
}

/** `fn`이 걸린 시간을 `label`에 쌓는다. 던져도 쌓고 그대로 던진다. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!ON) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(label, performance.now() - start);
  }
}

/** 이미 잰 시간이나 건수를 쌓는다. */
export function observe(label: string, ms = 0) {
  if (ON) record(label, ms);
}

/**
 * 일어난 일 하나를 한 줄로 남긴다(T121). 창으로 뭉치면 안 되는 것들이다 — 어느 대회의
 * 누가 언제 시간 초과로 폴드됐는지는 건수가 아니라 시각과 대회로 읽는다. `[event]`로 거른다.
 */
export function event(name: string, fields: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  if (ON) console.log(`[event] ${JSON.stringify({ t: Date.now(), name, ...fields })}`);
}

/** 창마다 한 번 읽는 현재값(pg 풀 대기 수 같은 것). */
export function gauge(label: string, read: () => Record<string, number>) {
  if (ON) gauges.set(label, read);
}

if (ON) {
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let cpuAt = process.cpuUsage();
  setInterval(() => {
    // 창 동안 이 프로세스가 쓴 CPU(%). 100이면 코어 하나를 다 썼다.
    const cpu = process.cpuUsage(cpuAt);
    cpuAt = process.cpuUsage();
    const out: Record<string, unknown> = {
      t: new Date().toISOString(),
      cpu: Math.round((cpu.user + cpu.system) / (WINDOW_MS * 10)),
      lag: { p50: Math.round(lag.percentile(50) / 1e6), p99: Math.round(lag.percentile(99) / 1e6), max: Math.round(lag.max / 1e6) },
    };
    lag.reset();
    for (const [label, read] of gauges) out[label] = read();
    for (const [label, s] of stats) {
      out[label] = { n: s.n, avg: Math.round(s.sum / s.n), max: Math.round(s.max), sum: Math.round(s.sum) };
    }
    stats.clear();
    // eslint-disable-next-line no-console
    console.log(`[stage] ${JSON.stringify(out)}`);
  }, WINDOW_MS).unref();
}

/**
 * 부팅부터 `LOAD_CPU_PROFILE_S`초 동안 CPU 프로파일을 떠서 `/tmp/boot.cpuprofile`에 쓴다(T119).
 * 재기동 직후의 재접속 몰림에서 코어를 무엇이 쓰는지 본다. 크롬 개발자 도구가 여는 형식이다.
 */
const PROFILE_S = Number(process.env.LOAD_CPU_PROFILE_S ?? 0);
if (ON && PROFILE_S > 0) {
  const session = new Session();
  session.connect();
  session.post('Profiler.enable', () => session.post('Profiler.start', () => {
    setTimeout(() => session.post('Profiler.stop', (_error, result) => {
      writeFileSync('/tmp/boot.cpuprofile', JSON.stringify(result.profile));
      // eslint-disable-next-line no-console
      console.log('[stage] cpuprofile written');
    }), PROFILE_S * 1000).unref();
  }));
}
