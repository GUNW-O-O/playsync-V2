// @ts-check
import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * 정산 촬영. **같은 시드에서 마무리를 여러 번 찍는다.**
 *
 * 대회를 끝내는 길이 여럿인데 하나가 문을 닫으면 나머지는 찍을 자리가 없다.
 * 그래서 마무리마다 **시드를 다시 깔고 처음부터 다시 돈다** — 시드가 지우고
 * 다시 만드는 물건이라(`backend/prisma/seed.ts`) 매번 같은 출발이 보장되고,
 * 그것이 이 촬영이 주장하는 것의 근거다.
 *
 * ```
 * 걷은 참가비 == 나간 상금 + 환불 + 상점 몫
 * ```
 *
 * 세 실행의 왼쪽 항이 같다. 시드가 정하는 값이라 시계와 무관하다. 오른쪽
 * 항의 **구성**만 문마다 다르다.
 *
 * ── 시계는 시드가 못 잡는다
 *
 * 블라인드 레벨은 저장된 값이 아니라 `startedAt`에서 매번 다시 계산한 값이다.
 * 실행마다 걸리는 시간이 다르면 갈림목에 다른 레벨로 도착하고, 그만큼 걷힌
 * 블라인드가 달라 **스택 분포가 갈린다.** 정산 무대의 레벨을 길게 잡은 것이
 * 그 때문이다 — 촬영 한 번이 끝날 때까지 레벨 1에 머문다.
 *
 * `--only=chop` 으로 하나만 찍는다. `--no-build`는 `demo.mjs`와 같다.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--no-build');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/**
 * 찍는 순서.
 *
 * **종료가 먼저다.** 셋 중 판을 가장 많이 돌리는 길이라, 앞선 단계가 어디서
 * 깨지든 여기서 먼저 드러난다. 찹과 중단은 같은 자리에서 갈라지므로 종료가
 * 통과하면 둘은 마지막 클릭만 다르다.
 */
const ENDINGS = ['complete', 'chop', 'abort'];
const plan = only ? [only] : ENDINGS;
if (only && !ENDINGS.includes(only)) {
  console.error(`--only는 ${ENDINGS.join(' · ')} 중 하나다. 받은 것: ${only}`);
  process.exit(1);
}

function run(command, args, cwd = ROOT, env = {}) {
  const { status } = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  });
  if (status !== 0) process.exit(status ?? 1);
}

// 빌드는 한 번이면 된다. 실행마다 바뀌는 것은 시드와 환경 변수뿐이다.
if (!skipBuild) run('npm', ['run', 'build:contract']);
if (!skipBuild) run('npm', ['run', 'build', '-w', 'frontend']);

for (const ending of plan) {
  console.log(`\n──────── 정산 촬영 · ${ending} ────────\n`);
  // 시드가 먼저다. 앞 실행이 대회를 닫아 놓았으므로 그 위에서 돌면 시작조차
  // 못 한다.
  run('npm', ['run', 'seed', '-w', 'backend']);
  run('npx', ['playwright', 'test', '--project=settlement'], resolve(ROOT, 'frontend'), {
    DEMO_PROD: '1',
    DEMO_ENDING: ending,
  });
}
