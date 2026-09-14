import { execSync } from 'child_process';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

/*
 * 실제 kill 검사(T97)의 무대 좌표. 셋업 · 스펙 · 정리가 같은 값을 봐야 해서
 * 여기 한 곳에 둔다 — 정리가 아무것도 import하지 않는 쪽이라 순환이 안 생긴다.
 */
export const OUTAGE_DIR = __dirname;
export const BACKEND_DIR = join(__dirname, '..', '..');
export const REPO_ROOT = join(BACKEND_DIR, '..');
export const COMPOSE_FILE = join(BACKEND_DIR, 'docker-compose.outage.yml');
export const PID_FILE = join(OUTAGE_DIR, '.pid');
export const LOG_FILE = join(OUTAGE_DIR, 'backend.log');
/** 시드가 쓰는 자리(`prisma/seed.ts`의 `MANIFEST_PATH`). 스펙도 여기서 읽는다. */
export const ROOT_MANIFEST = join(REPO_ROOT, '.demo-seed.json');
export const MANIFEST_BACKUP = join(OUTAGE_DIR, '.demo-seed.backup.json');

export const REDIS_CONTAINER = 'playsync-redis-outage';
export const BACKEND_PORT = 3201;
/** 개발(5432/6379) · 통합(5433/6380)과 다른 포트다. */
export const OUTAGE_ENV = {
  DATABASE_URL: 'postgresql://root:outage@127.0.0.1:5434/playsync?schema=public',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6381',
  REDIS_PASSWORD: 'outage',
};

/** 자식 백엔드를 내린다. pid 파일이 없으면 할 일이 없다. */
export async function stopBackend() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    // Windows에서는 TerminateProcess다. `node main.js`를 셸 없이 직접 띄웠으므로
    // 손자 프로세스가 없고, 이 한 번으로 끝난다.
    process.kill(pid);
  } catch {
    /* 이미 죽었다 */
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  unlinkSync(PID_FILE);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 시드가 덮은 매니페스트를 되돌린다. 백업이 없으면 원래 파일이 없었거나 셋업이
 * 옮기기 전에 멈춘 것이라 **아무것도 지우지 않는다** — 원본을 지우는 것보다 낡은
 * 좌표 하나가 남는 편이 싸다.
 */
export function restoreManifest() {
  if (existsSync(MANIFEST_BACKUP)) renameSync(MANIFEST_BACKUP, ROOT_MANIFEST);
}

/**
 * 자식 프로세스 종료 → 매니페스트 복원 → 컨테이너 내림.
 * 반복 실행은 `KEEP_OUTAGE_CONTAINERS=1`로 기동을 건너뛰고 `test:outage:down`으로 내린다.
 */
export default async function globalTeardown() {
  await stopBackend();
  restoreManifest();
  if (process.env.KEEP_OUTAGE_CONTAINERS === '1') {
    console.log('\n[kill 무대 유지] KEEP_OUTAGE_CONTAINERS=1 — 내리려면 npm run test:outage:down -w backend');
    return;
  }
  execSync(`docker compose -f "${COMPOSE_FILE}" down -v`, { stdio: 'inherit' });
}
