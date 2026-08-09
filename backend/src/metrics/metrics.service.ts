import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';

/** 나노초 → 밀리초. 소수 둘째 자리까지. */
function toMs(ns: number): number {
  return Math.round((ns / 1e6) * 100) / 100;
}

/**
 * 히스토그램 샘플링 간격이자 **지연의 바닥값**.
 *
 * `monitorEventLoopDelay`는 이 간격으로 타이머를 걸고 "예정 시각과 실제
 * 시각의 차"를 담는데, 그 차에 간격 자체가 포함된다. 그래서 완전히 유휴인
 * 서버도 p50이 약 10ms로 나온다. **10을 빼고 읽어야 실제 지연이다.**
 *
 * 응답에 `resolutionMs`로 같이 실어 보내는 이유가 이것이다 — 이 값을 모르면
 * 램프 분석이 유휴 상태를 "10ms 지연"으로 오독한다.
 *
 * 10ms면 libuv 타이머 하나로 충분히 싸고, 합격선(내 액션 p95 200ms)에 비해
 * 충분히 촘촘하다.
 */
const RESOLUTION_MS = 10;

export interface MetricsSnapshot {
  /** 직전 조회 이후 흐른 시간. 아래 값들이 덮는 구간이다. */
  windowMs: number;
  /** 지연의 바닥값. 이 값을 빼야 실제 지연이다 — `RESOLUTION_MS` 주석 참고. */
  resolutionMs: number;
  eventLoopLagMs: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
  };
  cpu: {
    userMs: number;
    systemMs: number;
    /** 코어 하나 기준. 컨테이너가 `cpus: 1`이므로 100%가 포화다. */
    percent: number;
  };
  memoryMb: {
    rss: number;
    heapUsed: number;
  };
}

/**
 * 부하 실행 중의 서버 내부 지표.
 *
 * **이벤트 루프 지연은 프로세스 밖에서 잴 수 없다.** `monitorEventLoopDelay`가
 * 내부 API라 `docker stats`도 k6도 그 값에 닿지 못한다. 그런데 이 값이 필요한
 * 이유는, 응답 p95만 보면 이미 무너진 뒤에야 신호가 오기 때문이다 — CPU가
 * 100%를 치기 전부터 지연은 벌어지기 시작하고, 그 구간을 못 보면 "이 인스턴스에
 * 상점 몇 개"의 경계가 뭉개진다. lag이 선행 지표다.
 *
 * **조회할 때마다 창이 닫히고 새로 열린다.** 히스토그램을 리셋하고 CPU도 직전
 * 조회 이후의 증분으로 준다. 램프의 단계마다 한 번씩 읽으면 그 단계만의 값이
 * 나온다 — 대회 전체의 누적 평균은 어느 단계에서 꺾였는지를 지운다.
 *
 * 이 서비스는 `LOAD_METRICS=1`일 때만 모듈째 등록된다(`app.module.ts`). 꺼져
 * 있으면 히스토그램 타이머도 라우트도 존재하지 않는다.
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private histogram?: IntervalHistogram;
  private lastCpu = process.cpuUsage();
  private lastAt = Date.now();

  onApplicationBootstrap(): void {
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
  }

  onApplicationShutdown(): void {
    this.histogram?.disable();
  }

  read(): MetricsSnapshot {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const windowMs = Math.max(now - this.lastAt, 1);
    const mem = process.memoryUsage();
    const h = this.histogram;

    const snapshot: MetricsSnapshot = {
      windowMs,
      resolutionMs: RESOLUTION_MS,
      eventLoopLagMs: {
        p50: h ? toMs(h.percentile(50)) : 0,
        p95: h ? toMs(h.percentile(95)) : 0,
        p99: h ? toMs(h.percentile(99)) : 0,
        max: h ? toMs(h.max) : 0,
        mean: h ? toMs(h.mean) : 0,
      },
      cpu: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
        // cpuUsage는 마이크로초다. 창(ms)과 맞추려면 1000으로 나눈다.
        percent: Math.round(((cpu.user + cpu.system) / 1000 / windowMs) * 1000) / 10,
      },
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      },
    };

    // 창을 닫고 다시 연다. 읽은 뒤에 해야 이번 값이 온전하다.
    h?.reset();
    this.lastCpu = process.cpuUsage();
    this.lastAt = now;

    return snapshot;
  }
}
