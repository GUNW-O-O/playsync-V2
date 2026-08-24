// @ts-check
import { existsSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

/**
 * README가 가리키는 그림이 전부 있는지, 그리고 이름이 규칙을 지키는지 본다.
 *
 * 이름이 곧 그 그림의 주장이라는 규칙은 **어긋난 것을 잡아 주는 장치가
 * 없으면 문서로만 남는다.** `img/`를 개명하면서 README 경로 하나를 놓치면
 * 그 자리가 404가 되는데, 타입 체커도 CI도 그것을 안 본다.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMG = join(ROOT, 'img');

/** `NN-내용.확장자`. 번호가 없는 것은 「지금 문서가 안 쓴다」는 표시다. */
const NUMBERED = /^(\d{2})-[a-z0-9-]+\.(webp|png)$/;

/** 번호 없이 남기기로 한 것. 늘어나면 여기에 적는다. */
const UNNUMBERED = new Set([
  'seat-waiting.png',
  'seat-joined.png',
  'dealer-refused-before-start.png',
  // 설계 없이 만든 정산 움짤. 새 그림이 자리를 대신한 뒤에 지운다.
  's6-six-all-in.webp',
  's7-entry-not-player.webp',
  's8-four-tables-to-one.webp',
  's9-close-icm.webp',
]);

const problems = [];

// 1. README가 가리키는 그림이 다 있나.
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const referenced = [...readme.matchAll(/\.\/img\/([^"')\s]+)/g)].map((m) => m[1]);
for (const name of referenced) {
  if (!existsSync(join(IMG, name))) problems.push(`README가 없는 그림을 가리킨다: img/${name}`);
}

// 2. 이름이 규칙을 지키나.
const files = readdirSync(IMG).filter((f) => /\.(webp|png)$/.test(f));
for (const file of files) {
  if (UNNUMBERED.has(file)) continue;
  if (!NUMBERED.test(file)) problems.push(`이름이 규칙을 안 지킨다: img/${file}`);
}

// 3. 번호가 겹치나. 겹치면 `ls`가 목차 노릇을 못 한다.
const seen = new Map();
for (const file of files) {
  const m = NUMBERED.exec(file);
  if (!m) continue;
  const had = seen.get(m[1]);
  if (had) problems.push(`번호가 겹친다: ${m[1]} — ${had} · ${file}`);
  seen.set(m[1], file);
}

// 「번호를 받고도 README가 안 쓰이는 그림」은 **일부러 안 본다.** 정산 스틸
// 아홉이 그 상태이고(README에 아직 정산 절이 없다), 그것을 검사로 만들면
// 이 검사를 통과시키려고 README 구조를 건드리게 된다 — 층을 나누는 판단은
// 그림을 다 보고 나야 서므로 별도 브랜치의 일이다(설계 문서 §5-6).

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`그림 이름 ${files.length}개 확인.`);
