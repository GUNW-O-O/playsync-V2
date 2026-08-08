// @ts-check
import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * 촬영 한 번. 시드 → 프론트 빌드 → Playwright(`--project=demo`).
 *
 * **프로덕션 빌드로 찍는다.** 개발 서버는 화면마다 좌하단에 Next 개발
 * 표시기를 앉히고, 라우트를 처음 열 때마다 컴파일하느라 흰 화면을 길게
 * 남긴다. 둘 다 영상에 그대로 들어간다.
 *
 * 이 파일이 npm 스크립트가 아닌 이유는 환경 변수 하나 때문이다 —
 * `DEMO_PROD=1 playwright test`는 Windows의 cmd에서 돌지 않는다. 워크스페이스
 * 스크립트를 셸 문법으로 갈라 놓는 것보다 노드로 한 번 감싸는 편이 낫다.
 *
 * `--no-build`로 빌드를 건너뛴다. 스펙만 고치며 여러 번 돌릴 때 쓴다.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--no-build');

function run(command, args, cwd = ROOT, env = {}) {
  const { status } = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (status !== 0) process.exit(status ?? 1);
}

// 시드는 지우고 다시 만든다. 데모가 매번 같은 화면에서 시작해야 해서다.
run('npm', ['run', 'seed', '-w', 'backend']);
if (!skipBuild) run('npm', ['run', 'build:contract']);
if (!skipBuild) run('npm', ['run', 'build', '-w', 'frontend']);
run('npx', ['playwright', 'test', '--project=demo'], resolve(ROOT, 'frontend'), {
  DEMO_PROD: '1',
});
