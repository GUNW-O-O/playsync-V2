import { execSync, spawn } from 'child_process';
import { existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import globalTeardown, {
  BACKEND_DIR,
  BACKEND_PORT,
  COMPOSE_FILE,
  LOG_FILE,
  MANIFEST_BACKUP,
  OUTAGE_DIR,
  OUTAGE_ENV,
  PID_FILE,
  REPO_ROOT,
  ROOT_MANIFEST,
  stopBackend,
} from './global-teardown';

/**
 * 실제 kill 검사(T97)의 무대를 세운다 — 컨테이너, 스키마, 데모 시드, 빌드한 백엔드.
 *
 * 셋업이 던지면 jest는 정리를 부르지 않는다. 그래서 여기서 직접 정리하고 다시
 * 던진다 — 안 그러면 자식 백엔드가 남고 매니페스트가 시드 것으로 남는다.
 */
export default async function globalSetup() {
  try {
    await bringUp();
  } catch (e) {
    await globalTeardown();
    throw e;
  }
}

async function bringUp() {
  // m1(최종 리뷰). Ctrl+C로 죽은 지난 실행은 `globalTeardown`을 안 타서
  // 자식 백엔드가 3201에 살아 남을 수 있다(Windows 자식은 부모보다 오래
  // 산다) — `.pid`는 그 죽은 척하는 자식을 가리킨다. 먼저 그걸 죽이고,
  // 그래도 뭔가 응답하면(`.pid`가 없거나 이미 낡았는데 다른 프로세스가
  // 그 포트를 쥔 경우) 새 자식이 EADDRINUSE로 죽어도 "아무 응답이나 오면
  // 통과"하는 준비 폴링이 그 낡은 프로세스를 진짜로 구운 것처럼 속아
  // 넘어간다. 그래서 여기서 미리 멈춘다.
  await stopBackend();
  if (await answersOnPort()) {
    throw new Error(
      `127.0.0.1:${BACKEND_PORT}에 이미 뭔가 응답하고 있다 — 지난 실행이 정리 없이 죽은 것으로 보인다. ` +
        `그 프로세스를 직접 찾아 끝낸 뒤(예: \`netstat -ano | findstr :${BACKEND_PORT}\`로 pid를 찾아 ` +
        `\`taskkill /PID <pid> /F\`) 다시 실행한다.`,
    );
  }

  execSync(`docker compose -f "${COMPOSE_FILE}" up -d --wait`, { stdio: 'inherit' });

  // **있어도 매번 빌드한다.** `dist`가 있다는 것은 지금 소스로 구웠다는 뜻이
  // 아니다 — 낡은 빌드로 돌면 고치기 전 코드를 재고도 초록이 나온다. contract가
  // 먼저다(백엔드가 그 빌드 산출물을 import한다).
  execSync('npm run build:contract && npm run build -w backend', { cwd: REPO_ROOT, stdio: 'inherit' });

  // 시드가 리포 루트의 매니페스트를 덮는다. 백업이 이미 있으면 지난 실행이
  // 정리 없이 죽은 것이고, 지금 루트에 있는 것은 그 실행의 시드다 — 옮기면
  // 진짜 원본을 덮는다.
  if (existsSync(ROOT_MANIFEST) && !existsSync(MANIFEST_BACKUP)) {
    renameSync(ROOT_MANIFEST, MANIFEST_BACKUP);
  }

  const env = { ...process.env, ...OUTAGE_ENV };
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, stdio: 'inherit', env });
  execSync('npx prisma db seed', { cwd: BACKEND_DIR, stdio: 'inherit', env });

  const log = openSync(LOG_FILE, 'w');
  // 셸 없이 node를 직접 띄운다 — Windows에서 `npx`·`npm`을 거치면 pid가 셸의
  // 것이라 kill이 백엔드에 닿지 않는다. **작업 디렉터리를 이 폴더로 둔다** —
  // `main.ts`의 `dotenv/config`가 `backend/.env`(개발 값)를 읽지 않게 하려는 것이다.
  const child = spawn(process.execPath, [join(BACKEND_DIR, 'dist', 'src', 'main.js')], {
    cwd: OUTAGE_DIR,
    env: {
      ...env,
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
      throw new Error(`백엔드가 뜨다 죽었다 (exit ${exited}):\n${tail(LOG_FILE)}`);
    }
    try {
      // 상태는 상관없다 — 응답이 오면 HTTP가 받는다는 뜻이다.
      await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`백엔드가 60초 안에 안 떴다:\n${tail(LOG_FILE)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** 지금 3201에 뭔가 떠서 HTTP로 응답하는가. 상태는 상관없다 — 응답이 오면 무언가 있다는 뜻이다. */
async function answersOnPort(): Promise<boolean> {
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

function tail(file: string) {
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(-40).join('\n');
}
