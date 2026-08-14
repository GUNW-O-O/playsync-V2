import { Trend, Gauge, Counter } from 'k6/metrics';
import { sleep } from 'k6';
import { metrics as readMetrics } from './api.js';

/**
 * 서버 내부 지표를 주기적으로 읽어 **시계열로** 남긴다.
 *
 * 실행이 끝난 뒤의 요약 하나로는 "터졌다"까지만 알 수 있다. 정작 필요한 것은
 * **언제부터 지연이 보이기 시작했고, 언제 급해졌고, 어디서 무너졌는가**다 —
 * 그게 있어야 "테이블 몇 개까지"라는 답이 나온다.
 *
 * 그래서 이 VU는 게임을 하지 않고 `/internal/metrics`만 반복해서 읽는다.
 * 읽는 행위 자체가 창을 닫고 다시 여는 것이라(메트릭 서비스의 설계), 각
 * 샘플은 **직전 샘플 이후 구간**을 덮는다 — 누적 평균이 아니다.
 *
 * 원시 시계열은 k6의 `--out json=`이 타임스탬프와 태그까지 그대로 떨어뜨린다.
 * 여기서 하는 일은 그 위에 **판정**을 얹는 것이다: 처음 넘은 순간, 크게
 * 넘은 순간을 로그로 박아 사람이 파일을 열지 않고도 지점을 알게 한다.
 */

/** 이벤트 루프 지연(바닥값을 뺀 실제 지연). 램프의 주 지표다. */
export const serverLagP95 = new Trend('server_lag_p95_ms', true);
export const serverCpuPercent = new Gauge('server_cpu_percent');
export const serverRssMb = new Gauge('server_rss_mb');
/** 경보가 처음 뜬 뒤로 몇 번이나 유지됐는지. 한 번 튄 것과 무너진 것을 가른다. */
export const lagWarnings = new Counter('lag_warnings');
export const lagBreaches = new Counter('lag_breaches');

/** 여기부터 "지연이 보이기 시작했다". 사람은 아직 못 느낀다. */
const WARN_MS = Number(__ENV.LOAD_LAG_WARN_MS || 20);
/** 여기부터 "무너지는 중이다". 내 액션 합격선(200ms)의 절반이다. */
const BREACH_MS = Number(__ENV.LOAD_LAG_BREACH_MS || 100);

/**
 * 지표를 한 번 읽고 기록·판정한다.
 *
 * @param label 지금 램프가 어느 단계인지. 태그로 붙어 시계열에서 갈린다.
 * @returns 읽은 원본
 */
export function sample(label) {
  const m = readMetrics();
  // **바닥값을 뺀다.** `monitorEventLoopDelay`는 샘플링 간격만큼을 늘 얹어
  // 돌려주므로(유휴 서버도 p50이 약 10ms), 빼지 않으면 시계열 전체가 그만큼
  // 들려 있어 "언제부터 올랐나"의 기준선이 흐려진다.
  const lag = Math.max(0, m.eventLoopLagMs.p95 - m.resolutionMs);
  const tags = { step: label };

  serverLagP95.add(lag, tags);
  serverCpuPercent.add(m.cpu.percent, tags);
  serverRssMb.add(m.memoryMb.rss, tags);

  if (lag >= BREACH_MS) {
    lagBreaches.add(1, tags);
    console.error(
      `[무너짐] ${label} · lag p95 ${lag}ms (기준 ${BREACH_MS}) · CPU ${m.cpu.percent}% · rss ${m.memoryMb.rss}MB`,
    );
  } else if (lag >= WARN_MS) {
    lagWarnings.add(1, tags);
    console.warn(
      `[지연 감지] ${label} · lag p95 ${lag}ms (기준 ${WARN_MS}) · CPU ${m.cpu.percent}%`,
    );
  }

  return m;
}

/**
 * 실행이 끝날 때까지 주기적으로 읽는다. 램프에서는 이것만 도는 VU를 하나 둔다.
 *
 * 간격이 짧으면 창이 잘게 쪼개져 p95가 흔들리고, 길면 꺾이는 지점을 놓친다.
 * 5초면 램프 한 단계(수십 초~수 분) 안에 여러 점이 찍힌다.
 */
export function watch(labelFn, durationMs, intervalMs) {
  const every = intervalMs || Number(__ENV.LOAD_SAMPLE_MS || 5000);
  const until = Date.now() + durationMs;
  // 첫 샘플은 버린다 — 직전 창이 부팅부터 지금까지라 램프와 무관한 구간이다.
  sample('warmup');
  while (Date.now() < until) {
    sleep(every / 1000);
    sample(typeof labelFn === 'function' ? labelFn() : labelFn);
  }
}
