import { execSync } from 'child_process';
import { join } from 'path';

const composeFile = join(__dirname, '..', 'docker-compose.test.yml');

/**
 * 테스트 인프라를 내린다.
 *
 * CI에서는 러너가 관리하므로 건너뛴다.
 * 로컬에서 같은 테스트를 반복해서 돌릴 때는 KEEP_TEST_CONTAINERS=1로 유지할 수 있다.
 * 기동 시간이 매번 빠지므로 TDD 루프가 훨씬 빨라진다.
 */
export default async function globalTeardown() {
  if (process.env.CI === 'true') return;
  if (process.env.KEEP_TEST_CONTAINERS === '1') {
    console.log('\n[테스트 인프라 유지] KEEP_TEST_CONTAINERS=1 — 내리려면 npm run test:int:down');
    return;
  }

  execSync(`docker compose -f "${composeFile}" down -v`, { stdio: 'inherit' });
}
