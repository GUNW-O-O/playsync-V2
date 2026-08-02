import { defineConfig } from '@playwright/test';

/**
 * 촬영용 하네스.
 *
 * 여기 있는 스펙의 목적은 **회귀를 잡는 것이 아니라 영상을 만드는 것**이다.
 * 회귀는 이미 세 계층(단위 · 통합 · 시나리오)이 백엔드에서 잡고 있고, 이쪽은
 * 화면 넷이 같은 대회를 동시에 비추는 장면 — 그건 브라우저 없이 만들 수 없다.
 *
 * 그래서 기본값 몇 개가 일반적인 e2e와 다르다.
 *
 * - **재시도 없음.** 재시도는 상태가 없는 테스트를 전제하는데 여기서는 한
 *   대회가 시작부터 탈락까지 한 방향으로 흘러간다. 두 번째 시도는 첫 번째가
 *   남긴 상태 위에서 도는 다른 시나리오다.
 * - **워커 하나.** 같은 이유다. 대회는 하나뿐이다.
 * - **영상은 항상 남긴다.** 실패했을 때만 남기는 것이 기본값이지만, 여기서는
 *   성공한 실행의 영상이 산출물이다.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 촬영은 사람이 돌린다. 실패를 조용히 넘기지 않는다.
  forbidOnly: true,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    // 화면마다 크기가 달라 컨텍스트 단위로 다시 정한다(`fixtures/surfaces.ts`).
    // 여기 두는 것은 면과 무관한 것뿐이다.
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'on-first-retry',
  },
  /**
   * 앱은 컨테이너에 없다(`backend/docker-compose.yml` 주석). 호스트에서 도는
   * 개발 서버 둘에 붙는데, 이미 떠 있으면 그것을 쓴다 — 촬영은 보통 서버를
   * 켜 놓은 채로 여러 번 돌린다.
   *
   * `url` 대신 `port`인 이유: Playwright의 `url`은 2xx~3xx를 기다리는데
   * 백엔드 루트는 라우트가 없어 404다(T32에서 `app.controller`를 지웠다).
   * 포트가 연결을 받는지만 본다.
   */
  webServer: [
    {
      command: 'npm run dev:backend',
      cwd: '..',
      port: 3001,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      command: 'npm run dev:frontend',
      cwd: '..',
      port: 3000,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});
