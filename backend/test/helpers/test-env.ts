import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 통합 테스트용 환경변수를 process.env에 적용한다.
 *
 * CI에서는 워크플로가 이미 환경변수를 넣어주므로 .env.test를 읽지 않는다.
 * 로컬에서는 이 파일이 유일한 설정 출처다.
 */
export function applyTestEnv(): void {
  if (process.env.CI === 'true') return;

  const raw = readFileSync(join(__dirname, '..', '..', '.env.test'), 'utf8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
