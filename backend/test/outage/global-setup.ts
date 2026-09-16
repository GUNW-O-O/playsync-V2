import { execSync } from 'child_process';
import { existsSync, renameSync, writeFileSync } from 'fs';
import globalTeardown, {
  answersOnPort,
  BACKEND_DIR,
  BACKEND_PORT,
  COMPOSE_FILE,
  LOG_FILE,
  MANIFEST_BACKUP,
  OUTAGE_ENV,
  REPO_ROOT,
  ROOT_MANIFEST,
  startBackend,
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

  // 로그를 새로 시작한다 — 재시작이 이어 쓰므로(`startBackend`는 append)
  // 여기서만 비운다.
  writeFileSync(LOG_FILE, '');
  await startBackend();
}
