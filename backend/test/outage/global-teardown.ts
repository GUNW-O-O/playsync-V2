import { execSync, spawn } from 'child_process';
import { existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
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

/**
 * 빌드한 백엔드를 자식 프로세스로 띄우고, HTTP가 응답할 때까지 기다린다.
 *
 * **셋업과 스펙이 같은 함수를 쓴다**(T107). 스펙이 백엔드를 죽였다 다시 올리는데
 * 그 방법이 셋업 안에만 있으면 두 벌이 되고, 한쪽만 고쳐지는 날 「무대가 다르게
 * 선 채로 초록」이 된다.
 *
 * 셸 없이 node를 직접 띄운다 — Windows에서 `npx`·`npm`을 거치면 pid가 셸의
 * 것이라 kill이 백엔드에 닿지 않는다. 작업 디렉터리를 이 폴더로 두는 것은
 * `main.ts`의 `dotenv/config`가 `backend/.env`(개발 값)를 읽지 않게 하려는 것이다.
 *
 * @returns 포트가 처음 응답한 시각. 부팅 복구가 끝난 **뒤에야** 포트가 열린다는
 *   것이 제품의 약속이므로(`app.listen()`이 `onApplicationBootstrap`을 기다린다),
 *   이 시각 이후에 본 상태는 「복구가 끝난 상태」다.
 */
export async function startBackend(): Promise<number> {
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [join(BACKEND_DIR, 'dist', 'src', 'main.js')], {
    cwd: OUTAGE_DIR,
    env: {
      ...process.env,
      ...OUTAGE_ENV,
      PORT: String(BACKEND_PORT),
      JWT_SECRET: 'outage-test-secret',
      WS_ALLOWED_ORIGINS: 'http://localhost:3000',
    },
    stdio: ['ignore', log, log],
  });
  // 전역 셋업과 스펙은 다른 컨텍스트라 `globalThis`로 못 넘긴다.
  writeFileSync(PID_FILE, String(child.pid));
  let exited: number | null = null;
  child.on('exit', (code) => { exited = code ?? -1; });
  child.unref();

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited !== null) {
      throw new Error(`백엔드가 뜨다 죽었다 (exit ${exited}):\n${tailLog()}`);
    }
    if (await answersOnPort()) return Date.now();
    if (Date.now() > deadline) throw new Error(`백엔드가 60초 안에 안 떴다:\n${tailLog()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 지금 3201에 뭔가 떠서 HTTP로 응답하는가. 상태는 상관없다 — 응답이 오면 무언가 있다는 뜻이다. */
export async function answersOnPort(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

export function tailLog(lines = 40) {
  try {
    return readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(로그 없음)';
  }
}

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
