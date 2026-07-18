import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const backendDir = join(__dirname, '..');
const composeFile = join(backendDir, 'docker-compose.test.yml');

/**
 * 통합 테스트 인프라를 띄우고 스키마를 적용한다.
 *
 * CI에서는 러너가 services 블록으로 이미 컨테이너를 띄우므로 compose를 건너뛴다.
 * 로컬에서는 `npm run test:int` 한 번으로 기동까지 끝나야 하므로 여기서 올린다.
 */
export default async function globalSetup() {
  const managedByCi = process.env.CI === 'true';

  if (!managedByCi) {
    if (!existsSync(composeFile)) {
      throw new Error(`docker-compose.test.yml을 찾을 수 없습니다: ${composeFile}`);
    }
    // --wait은 healthcheck가 통과할 때까지 블록한다. 임의의 sleep이 필요 없다.
    execSync(`docker compose -f "${composeFile}" up -d --wait`, {
      stdio: 'inherit',
    });
  }

  // 스키마의 진실은 Prisma 마이그레이션이다. 컨테이너에 SQL을 굽지 않는다.
  execSync('npx prisma migrate deploy', {
    cwd: backendDir,
    stdio: 'inherit',
    env: { ...process.env, ...loadTestEnv() },
  });
}

/** .env.test를 읽어 키/값으로 돌려준다. dotenv 의존성을 추가하지 않기 위한 최소 파서. */
export function loadTestEnv(): Record<string, string> {
  const { readFileSync } = require('fs') as typeof import('fs');
  const raw = readFileSync(join(backendDir, '.env.test'), 'utf8');
  const env: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}
