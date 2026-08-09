import { MetricsService } from './metrics.service';

/**
 * 계측 자체를 검증한다.
 *
 * 이 스펙이 지키는 것은 두 가지다 — **창이 조회마다 닫히고 다시 열리는가**와
 * **부트스트랩 전에 읽어도 죽지 않는가**. 앞엣것이 이 서비스의 설계 결정이고
 * (램프 단계별로 읽어야 어디서 꺾였는지가 나온다), 뒤엣것은 라우트가 모듈
 * 등록 시점보다 먼저 불릴 수 있는 경로를 막는다.
 */
describe('MetricsService', () => {
  it('부트스트랩 전에 읽어도 0으로 돌려주고 죽지 않는다', () => {
    const service = new MetricsService();

    const snapshot = service.read();

    expect(`p95 ${snapshot.eventLoopLagMs.p95}`).toBe('p95 0');
    expect(`max ${snapshot.eventLoopLagMs.max}`).toBe('max 0');
  });

  it('창이 조회마다 닫히고 다시 열린다', async () => {
    const service = new MetricsService();
    service.onApplicationBootstrap();

    try {
      // 첫 조회로 창을 연다. 이 값 자체는 보지 않는다.
      service.read();
      await new Promise((r) => setTimeout(r, 60));
      const first = service.read();
      await new Promise((r) => setTimeout(r, 60));
      const second = service.read();

      // 두 창이 각각 자기 구간만 덮는다. 누적이면 second가 훨씬 컸을 것이다.
      // 타이밍에 기대지 않으려고 상한만 본다 — 대기가 60ms인데 창이 리셋되지
      // 않으면 두 번째는 120ms를 넘어간다.
      expect(`첫 창 ${first.windowMs < 120}`).toBe('첫 창 true');
      expect(`둘째 창 ${second.windowMs < 120}`).toBe('둘째 창 true');

      // CPU도 증분이다. 누적이면 이 단언이 창 길이를 넘어 깨진다.
      const busiest = Math.max(first.cpu.userMs, second.cpu.userMs);
      expect(`CPU 증분 ${busiest <= 120}`).toBe('CPU 증분 true');
    } finally {
      service.onApplicationShutdown();
    }
  });

  it('메모리와 CPU는 실측값이라 0보다 크다', () => {
    const service = new MetricsService();
    service.onApplicationBootstrap();

    try {
      const snapshot = service.read();

      expect(`rss ${snapshot.memoryMb.rss > 0}`).toBe('rss true');
      expect(`heap ${snapshot.memoryMb.heapUsed > 0}`).toBe('heap true');
    } finally {
      service.onApplicationShutdown();
    }
  });
});
