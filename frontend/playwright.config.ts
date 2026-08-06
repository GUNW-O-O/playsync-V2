import { defineConfig } from '@playwright/test';

/**
 * 촬영 하네스이자 **화면의 회귀 계층**이다. 둘 다다.
 *
 * 처음(T33)에는 영상만 만드는 자리였다. 화면이 없었고, 있을 화면을 여기서
 * 단언하면 촬영 토대가 화면 한 번 고칠 때마다 빨개지기 때문이다.
 *
 * T34에서 성격이 하나 늘었다. 프론트 단위 테스트의 목은 **백엔드를 병렬로
 * 만들던 시절의 도구**였고, 백엔드가 다 선 지금은 목이 틀려도 그 사실을
 * 알려주는 것이 아무것도 없다. 실제로 두 번 사고가 났다 — 대회 전환 레이스가
 * 대회 하나짜리 배열에 가려졌고, `{ tournament, seatStatus }` 봉투를 안 벗기는
 * 코드가 봉투 없는 목 때문에 그 경로에 닿지도 못했다. 그래서 **봉투 모양 · 키
 * 이름 · 상태 전이는 진짜 백엔드가 판정한다.** 단위 테스트는 빠른 TDD 루프로
 * 남기고, 여기서는 화면의 색이나 배치를 단언하지 않는다.
 *
 * 무대는 시드가 깐다. 스펙이 **상태를 남기므로**(사람이 앉는다) 돌릴 때마다
 * 시드를 다시 깐다 — `npm run seed -w backend && npm run test:e2e`.
 *
 * 그래서 기본값 몇 개가 일반적인 e2e와 다르다.
 *
 * - **재시도 없음.** 재시도는 상태가 없는 테스트를 전제하는데 여기서는 한
 *   대회가 시작부터 탈락까지 한 방향으로 흘러간다. 두 번째 시도는 첫 번째가
 *   남긴 상태 위에서 도는 다른 시나리오다.
 * - **워커 하나.** 같은 이유다. 대회는 하나뿐이다. 파일 이름의 알파벳 순서가
 *   곧 실행 순서라, 상태를 남기는 스펙일수록 뒤에 온다
 *   (console → dealer → harness → terminal).
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
