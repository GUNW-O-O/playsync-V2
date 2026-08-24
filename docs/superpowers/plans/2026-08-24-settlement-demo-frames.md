# 정산 촬영 프레임 설계 적용 (T84) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정산 촬영이 설계된 프레임 넷을 내놓게 하고, `img/`의 파일 이름만으로 그 그림이 무엇을 주장하는지 알 수 있게 만든다.

**Architecture:** 촬영 스펙(`demo/settlement.spec.ts`)의 순서를 바꿔 대기 구간을 맨 뒤로 몰고, 면을 다섯에서 열둘로 늘려 프레임 셋을 한 컷씩 담는다. 자르는 쪽(`make-demo-assets.mjs`)은 타일마다 다른 촬영 실행을 가리킬 수 있게 축을 하나 늘린다 — 프레임 ③이 `chop`과 `complete` 두 실행을 좌우로 놓기 때문이다. 파일 이름은 `NN-<무엇을 보여주는가>`로 통일해 `ls img/`가 README의 목차가 되게 한다.

**Tech Stack:** Playwright (촬영 · `frontend/e2e/`), ffmpeg-static (자르기 · `scripts/make-demo-assets.mjs`), Node ESM 스크립트

**Spec:** [`docs/superpowers/specs/2026-08-24-settlement-demo-design.md`](../specs/2026-08-24-settlement-demo-design.md)

## Global Constraints

- **문서는 메인이 맡는다.** 하위 에이전트는 코드와 테스트만 만진다. `docs/`와 `CLAUDE.md`는 손대지 않는다. **주석은 예외다 — 주석은 코드라 그 PR에 함께 간다**(`CLAUDE.md`의 「문서는 메인이 맡는다」).
- **코드를 가리킬 때는 줄 번호가 아니라 이름으로.** 주석과 오류 메시지가 코드를 가리킬 때 함수·메서드·상수 이름을 쓴다.
- **완료를 주장하기 전에 실제로 명령을 실행하고 출력을 확인한다.**
- 커밋 메시지·주석은 한국어. 기존 파일의 언어를 따른다.
- **촬영 중에 제품 소스를 고치지 않는다.** Next dev가 hot reload하면서 워커가 죽는다(`code=3221226505`).
- **시드는 개발 DB를 지운다.** 촬영마다 다시 깔린다.
- 타입 체크는 루트에서 `npm run typecheck`.
- 파일 이름 규칙: `NN-<무엇을 보여주는가>.<webp|png>`. `NN`은 README 등장 순서. 안 쓰는 그림은 번호가 없다.

---

## File Structure

| 파일 | 책임 | 이 계획에서 |
|---|---|---|
| `img/` | README에 붙는 자산. git 추적됨 | Task 1에서 전부 개명, Task 7에서 갈아 끼움 |
| `README.md` | `img/` 경로 15곳 | Task 1에서 **경로만** 고침. 구조는 안 건드림 |
| `frontend/e2e/demo/settlement.spec.ts` | 정산 촬영 한 판 | Task 2·3·4 |
| `frontend/e2e/demo/tournament.spec.ts` | 장면 1~5 촬영 | Task 1에서 `shoot()` 이름만 |
| `scripts/make-demo-assets.mjs` | 원본을 자산으로 | Task 1(이름) · Task 6(cross-take) |

---

## Task 1: 파일 이름이 곧 내용이 되게 한다

`img/`를 `ls` 한 것만으로 무슨 그림인지 알 수 있게 만든다. **촬영을 안 돌리고 검증되는 유일한 태스크**라 먼저 한다.

**Files:**
- Modify: `img/` (git mv 24건)
- Modify: `README.md` (`img/` 경로 15곳)
- Modify: `scripts/make-demo-assets.mjs` (`SCENES`의 `out`, `STILLS`, `settlementScenes`의 `out`, `settlementStills`, `SETTLEMENT_CLOSE`)
- Modify: `frontend/e2e/demo/tournament.spec.ts` (`shoot()` 13곳)
- Modify: `frontend/e2e/demo/settlement.spec.ts` (`shoot()` 9곳)

**Interfaces:**
- Produces: 아래 이름표. Task 6의 `settlementScenes`가 `03`·`05`·`11`·`20`을 내고, Task 7이 `img/`에 넣는다.

### 이름표

**옮기는 것 (파일이 이미 있다)**

| 지금 | 새 이름 |
|---|---|
| `s1-join.webp` | `01-join-phone-to-console.webp` |
| `s3-sidepot.webp` | `02-sidepot-dealer-refused.webp` |
| `scoreboard-prize-final.png` | `04-prize-table-locked.png` |
| `s2-hand.webp` | `06-one-click-four-surfaces.webp` |
| `seat-game.png` | `07-seat-view-of-table.png` |
| `dealer-felt.png` | `08-dealer-view-of-table.png` |
| `dealer-winner.png` | `09-winner-pot-layers.png` |
| `dealer-refused.png` | `10-unnamed-pot-refused.png` |
| `seat-rebuy-raises-entry.png` | `12-rebuy-accept-raises-entry.png` |
| `scoreboard-entry-not-player.png` | `13-entry-36-players-35.png` |
| `s5-table-merge.webp` | `14-seat-move-closeup.webp` |
| `seat-moved.png` | `15-stack-survives-move.png` |
| `console-four-tables.png` | `16-four-tables-rake-10.png` |
| `console-final-table.png` | `17-final-table-origins.png` |
| `console-finish-blocked.png` | `18-finish-blocked-reasons.png` |
| `console-chop-ledger.png` | `19-chop-ledger-sums.png` |
| `console-abort-ledger.png` | `21-abort-ledger-groups.png` |
| `console-closed-chop.png` | `23-closed-chop.png` |
| `seat-rebuy.png` | `25-rebuy-overlay.png` |
| `phone-eliminated.png` | `26-phone-shows-rank.png` |
| `console.png` | `27-console-layout.png` |
| `scoreboard.png` | `28-scoreboard-layout.png` |
| `phone-me.png` | `29-phone-entry-otp.png` |
| `console-dealer-otp.png` | `30-console-dealer-otp.png` |

**번호를 안 주는 것 (지금 README가 안 쓴다)** — 그대로 둔다.
`seat-waiting.png` · `seat-joined.png` · `dealer-refused-before-start.png`

**아직 없는 것** — 코드에만 이름을 박는다. 파일은 Task 7에서 생긴다.
`03-four-tables-to-one.webp` · `05-two-doors-same-ledger.webp` · `11-entry-not-player.webp` · `20-abort-refunds-all.webp` · `22-closed-complete.png` · `24-closed-abort.png`

**지우지 않는 것** — `s6-six-all-in.webp` · `s7-entry-not-player.webp` · `s8-four-tables-to-one.webp` · `s9-close-icm.webp`. Task 7에서 새 그림이 들어온 뒤에 지운다.

- [ ] **Step 1: 이름이 어긋난 것을 잡는 검사를 쓴다**

Create: `scripts/check-image-names.mjs`

```js
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
```

- [ ] **Step 2: 검사를 돌려 실패를 본다**

Run: `node scripts/check-image-names.mjs`

Expected: FAIL. `이름이 규칙을 안 지킨다: img/console.png` 를 비롯해 24건 이상이 뜬다. **이 실패를 눈으로 확인하고 다음으로 간다** — 통과하면 검사가 아무것도 안 보고 있다는 뜻이다.

- [ ] **Step 3: `img/`를 개명한다**

```bash
cd img
git mv s1-join.webp 01-join-phone-to-console.webp
git mv s3-sidepot.webp 02-sidepot-dealer-refused.webp
git mv scoreboard-prize-final.png 04-prize-table-locked.png
git mv s2-hand.webp 06-one-click-four-surfaces.webp
git mv seat-game.png 07-seat-view-of-table.png
git mv dealer-felt.png 08-dealer-view-of-table.png
git mv dealer-winner.png 09-winner-pot-layers.png
git mv dealer-refused.png 10-unnamed-pot-refused.png
git mv seat-rebuy-raises-entry.png 12-rebuy-accept-raises-entry.png
git mv scoreboard-entry-not-player.png 13-entry-36-players-35.png
git mv s5-table-merge.webp 14-seat-move-closeup.webp
git mv seat-moved.png 15-stack-survives-move.png
git mv console-four-tables.png 16-four-tables-rake-10.png
git mv console-final-table.png 17-final-table-origins.png
git mv console-finish-blocked.png 18-finish-blocked-reasons.png
git mv console-chop-ledger.png 19-chop-ledger-sums.png
git mv console-abort-ledger.png 21-abort-ledger-groups.png
git mv console-closed-chop.png 23-closed-chop.png
git mv seat-rebuy.png 25-rebuy-overlay.png
git mv phone-eliminated.png 26-phone-shows-rank.png
git mv console.png 27-console-layout.png
git mv scoreboard.png 28-scoreboard-layout.png
git mv phone-me.png 29-phone-entry-otp.png
git mv console-dealer-otp.png 30-console-dealer-otp.png
cd ..
```

- [ ] **Step 4: README의 경로를 고친다**

**구조는 안 건드린다. `src` 경로만 바꾼다.**

```bash
sed -i \
 -e 's|\./img/s1-join\.webp|./img/01-join-phone-to-console.webp|g' \
 -e 's|\./img/s3-sidepot\.webp|./img/02-sidepot-dealer-refused.webp|g' \
 -e 's|\./img/s2-hand\.webp|./img/06-one-click-four-surfaces.webp|g' \
 -e 's|\./img/seat-game\.png|./img/07-seat-view-of-table.png|g' \
 -e 's|\./img/dealer-felt\.png|./img/08-dealer-view-of-table.png|g' \
 -e 's|\./img/dealer-winner\.png|./img/09-winner-pot-layers.png|g' \
 -e 's|\./img/dealer-refused\.png|./img/10-unnamed-pot-refused.png|g' \
 -e 's|\./img/s5-table-merge\.webp|./img/14-seat-move-closeup.webp|g' \
 -e 's|\./img/seat-moved\.png|./img/15-stack-survives-move.png|g' \
 -e 's|\./img/seat-rebuy\.png|./img/25-rebuy-overlay.png|g' \
 -e 's|\./img/phone-eliminated\.png|./img/26-phone-shows-rank.png|g' \
 -e 's|\./img/console\.png|./img/27-console-layout.png|g' \
 -e 's|\./img/scoreboard\.png|./img/28-scoreboard-layout.png|g' \
 -e 's|\./img/phone-me\.png|./img/29-phone-entry-otp.png|g' \
 -e 's|\./img/console-dealer-otp\.png|./img/30-console-dealer-otp.png|g' \
 README.md
```

`console.png` 치환이 `console-dealer-otp.png`를 건드리지 않는 것은 패턴에 `\.png`가 붙어 있어서다. 순서도 그래서 상관없다.

- [ ] **Step 5: 촬영이 남기는 스틸 이름을 고친다**

Modify: `frontend/e2e/demo/tournament.spec.ts` — `shoot()` 호출 13곳

```
shoot(phone, 'phone-me')                       → shoot(phone, '29-phone-entry-otp')
shoot(console_, 'console')                     → shoot(console_, '27-console-layout')
shoot(console_, 'console-dealer-otp')          → shoot(console_, '30-console-dealer-otp')
shoot(dealer, 'dealer-refused-before-start')   → 그대로 (번호 없음)
shoot(board, 'scoreboard')                     → shoot(board, '28-scoreboard-layout')
shoot(dealer, 'dealer-felt')                   → shoot(dealer, '08-dealer-view-of-table')
shoot(heroPage, 'seat-game')                   → shoot(heroPage, '07-seat-view-of-table')
shoot(dealer, 'dealer-refused')                → shoot(dealer, '10-unnamed-pot-refused')
shoot(dealer, 'dealer-winner')                 → shoot(dealer, '09-winner-pot-layers')
shoot(p1Page, 'seat-rebuy')                    → shoot(p1Page, '25-rebuy-overlay')
shoot(phone, 'phone-eliminated')               → shoot(phone, '26-phone-shows-rank')
shoot(moverPage, 'seat-moved')                 → shoot(moverPage, '15-stack-survives-move')
shoot(p2Page, 'seat-joined')                   → 그대로 (번호 없음)
```

Modify: `frontend/e2e/demo/settlement.spec.ts` — `shoot()` 호출 9곳

```
shoot(console_, 'console-four-tables')          → shoot(console_, '16-four-tables-rake-10')
shoot(rebuyerTablet, 'seat-rebuy-raises-entry') → shoot(rebuyerTablet, '12-rebuy-accept-raises-entry')
shoot(board, 'scoreboard-entry-not-player')     → shoot(board, '13-entry-36-players-35')
shoot(board, 'scoreboard-prize-final')          → shoot(board, '04-prize-table-locked')
shoot(console_, 'console-final-table')          → shoot(console_, '17-final-table-origins')
shoot(console_, 'console-finish-blocked')       → shoot(console_, '18-finish-blocked-reasons')
shoot(console_, 'console-chop-ledger')          → shoot(console_, '19-chop-ledger-sums')
shoot(console_, 'console-abort-ledger')         → shoot(console_, '21-abort-ledger-groups')
shoot(console_, `console-closed-${ENDING}`)     → shoot(console_, CLOSED_SHOT[ENDING])
```

마지막 줄만 접미사로 안 된다 — 번호가 마무리마다 다르다. 상수를 `ENDING` 정의 근처에 둔다.

```ts
/**
 * 닫힌 뒤의 스틸. **마무리마다 번호가 다르다.**
 *
 * 이름이 곧 README의 등장 순서라(`img/`의 규칙) 접미사 하나로 못 만든다.
 * 셋을 나란히 놓는 것이 이 스틸들의 요점이므로 번호도 연달아 준다.
 */
const CLOSED_SHOT = {
  complete: '22-closed-complete',
  chop: '23-closed-chop',
  abort: '24-closed-abort',
} as const;
```

- [ ] **Step 6: 자르는 쪽의 이름을 고친다**

Modify: `scripts/make-demo-assets.mjs`

`SCENES`의 `out`:
```
out: 's1-join'         → out: '01-join-phone-to-console'
out: 's2-hand'         → out: '06-one-click-four-surfaces'
out: 's3-sidepot'      → out: '02-sidepot-dealer-refused'
out: 's5-table-merge'  → out: '14-seat-move-closeup'
```

`STILLS` 배열을 통째로 바꾼다. **주석은 그 그림이 무엇을 주장하는지로 다시 적는다** — 이름이 이미 그것을 말하므로 주석은 이름이 못 담는 것만 남긴다.

```js
const STILLS = [
  '07-seat-view-of-table.png',
  '08-dealer-view-of-table.png', // 같은 테이블. 딜러가 아래에 있다
  '09-winner-pot-layers.png',
  '10-unnamed-pot-refused.png',
  '15-stack-survives-move.png',
  '25-rebuy-overlay.png',
  '26-phone-shows-rank.png',
  '27-console-layout.png',
  '28-scoreboard-layout.png',
  '29-phone-entry-otp.png',
  '30-console-dealer-otp.png',
  // 번호가 없는 것 — 지금 README가 안 쓴다. 촬영은 계속 남긴다.
  'seat-waiting.png',
  'seat-joined.png',
  'dealer-refused-before-start.png',
];
```

`settlementStills(ending)`도 새 이름으로. `SETTLEMENT_CLOSE`가 있으면 같이 고친다.

```js
function settlementStills(ending) {
  return [
    '16-four-tables-rake-10.png',
    '12-rebuy-accept-raises-entry.png',
    '13-entry-36-players-35.png',
    '04-prize-table-locked.png',
    '17-final-table-origins.png',
    '18-finish-blocked-reasons.png',
    ...(ending === 'chop' ? ['19-chop-ledger-sums.png'] : []),
    ...(ending === 'abort' ? ['21-abort-ledger-groups.png'] : []),
    { complete: '22-closed-complete.png', chop: '23-closed-chop.png', abort: '24-closed-abort.png' }[ending],
  ];
}
```

`settlementScenes(ending)`의 `out`은 **Task 6에서 통째로 다시 쓴다.** 여기서는 손대지 않는다 — 프레임 설계가 바뀌면서 장면 자체가 넷으로 재편되기 때문이다.

- [ ] **Step 7: 검사를 돌려 통과를 본다**

Run:
```bash
node scripts/check-image-names.mjs
npm run typecheck
```

Expected: `그림 이름 NN개 확인.` · 타입 에러 0.

`README가 없는 그림을 가리킨다`가 뜨면 Step 4의 `sed`가 한 줄을 놓친 것이다. 반대로 README에 옛 이름이 남았는지도 본다 — 그쪽은 검사가 아니라 grep이 잡는다.

```bash
grep -n 'img/\(s[0-9]\|console\.\|scoreboard\.\|seat-game\|dealer-felt\|dealer-winner\|dealer-refused\.\|seat-moved\|seat-rebuy\.\|phone-me\|phone-eliminated\|console-dealer-otp\)' README.md
```

Expected: 출력 없음.

- [ ] **Step 8: `package.json`에 검사를 건다**

Modify: `package.json` — `scripts`에 한 줄.

```json
"check:images": "node scripts/check-image-names.mjs"
```

이름 규칙이 사람 기억에만 있으면 다음 그림에서 깨진다.

- [ ] **Step 9: 커밋**

```bash
git add img README.md package.json scripts/check-image-names.mjs scripts/make-demo-assets.mjs frontend/e2e/demo/
git commit -m "chore: 그림 이름이 그 그림의 주장이 되게 한다

`ls img/`가 README의 목차가 되도록 `NN-<무엇을 보여주는가>`로 스물넷을
개명했다. `console.png`·`s2-hand`는 열어 봐야 무엇인지 알 수 있었고,
README가 그림을 고를 때마다 영상을 다시 여는 것이 그 값이었다.

이름 규칙이 문서로만 남지 않도록 `check:images`를 붙였다 — README가
가리키는 그림이 다 있는지, 번호가 겹치지 않는지, 번호를 받고도 안 쓰이는
그림이 없는지 본다. 번호가 없는 것은 「지금 문서가 안 쓴다」는 표시다."
```

---

## Task 2: 촬영 순서를 바꾸고 셋만 남긴다

**Files:**
- Modify: `frontend/e2e/demo/settlement.spec.ts`

**Interfaces:**
- Produces: 마크 이름 열넷. Task 6의 `settlementScenes`가 `from`/`to`로 그대로 쓴다.

```
무대 — 서른다섯이 자리에 앉는다
무대 — 대회가 열린다
무대 — 딜러 넷이 각자의 테이블에 붙는다
첫 판 — 한 판에 여섯이 올인한다
리바인 — 엔트리가 늘면 상금권도 는다
병합 — 네 테이블이 둘이 된다
둘째 판 — 두 테이블에서 열이 나간다
파이널 테이블 — 여섯이 한 테이블에 앉는다
마감 대기 — 여기부터 버린다
마감 — 상금이 예상에서 확정으로 바뀐다
셋만 남는다 — 상금이 세 번 나간다
마무리 — 셋이 한 화면에 있다
마무리 — ICM으로 닫는다 | 마무리 — 최후 1인 | 마무리 — 중단하고 환불한다
끝
```

- [ ] **Step 1: 대기 구간을 병합 뒤로 옮긴다**

지금 순서는 `첫 판 → 리바인 → [마감 대기] → 마감 → 병합① → 둘째 판 → 병합② → 여섯째`다. 대기 블록(`mark('마감 대기 — 여기부터 버린다')`부터 `shoot(board, '04-prize-table-locked')`까지)을 **`파이널 테이블 — 여섯이 한 테이블에 앉는다` 뒤로** 통째로 옮긴다.

옮기는 근거를 그 자리 주석에 남긴다.

```ts
    // ── 등록 마감을 기다린다 ────────────────────────────────────────
    //
    // **병합보다 뒤다.** 병합 자체는 등록이 열려 있어도 된다 —
    // `SessionService.releaseSeats`가 요구하는 것은 `GamePhase.WAITING`뿐이고
    // 등록 상태를 안 본다. 마감을 요구하는 것은 파이널 테이블 판정
    // 하나이고(`isFinalTable`), 그것이 여는 문은 ICM뿐이다.
    //
    // 앞에 두면 **리바인과 좌석 이동 사이에 8분이 통째로 낀다.** 둘은 한
    // 흐름이라(탈락자가 돌아와서 다른 테이블로 걸어간다) 그 사이가 끊기면
    // 프레임 하나로 못 붙는다. 뒤로 밀면 버릴 구간이 한 덩어리가 된다.
    //
    // 총 시간은 안 변한다. 마감은 대회 시작 후 10분에 오는 벽이고
    // (`SETTLEMENT_BLIND_STRUCTURE`의 레벨 1), 순서는 그 10분을 무엇으로
    // 채우느냐만 정한다.
```

- [ ] **Step 2: 마지막 판을 넷 올인으로 바꾼다**

지금:
```ts
    mark('여섯째 — 상금이 처음 나간다');
    await playHand(final, '여섯째', 2);
    await settleToWaiting(final, '여섯째');
```

바꿈:
```ts
    // ── 셋만 남긴다 ─────────────────────────────────────────────────
    //
    // **여섯 중 넷이 올인해 셋이 나간다.** 6·5·4위 상금이 여기서 나가고
    // 셋이 남는다.
    //
    // 셋인 이유가 둘이다. **마무리 프레임의 폰 셋이 「남은 전원」이 된다** —
    // 다섯이 남으면 그중 셋을 고르는 임의성이 생기고 그 선택을 설명할
    // 근거가 없다. 그리고 **이미 나간 상금이 셋이 되어** 마무리 확인 대화의
    // 「남은 상금」이 걷은 돈과 확연히 갈린다. 그 차이가 그 화면이 말하려는
    // 전부다.
    //
    // 둘(헤즈업)로 줄이지 않는다. ICM은 「칩 비율대로 **나눈다**」인데 둘이면
    // 비율이 하나뿐이라 나눈 티가 안 난다.
    //
    // 넷을 넘기지 않는 이유는 그대로다 — 여섯이 남은 자리에서 여섯이 올인하면
    // 그 판에 최후 1인이 나와 마무리를 고를 자리 자체가 사라진다.
    mark('셋만 남는다 — 상금이 세 번 나간다');
    await playHand(final, '셋만', 4);
    await settleToWaiting(final, '셋만');
```

`planHand`는 손대지 않는다. `occupiedSeats.slice(-count)`라 좌석 번호가 큰 넷이 올인하고 앞의 둘이 폴드하며, 승자는 올인자 중 스택 최대다 — 이미 결정적이다.

- [ ] **Step 3: `complete` 갈림목의 인원 주석을 고친다**

지금 주석이 「다섯이 남아 있으므로 한 판이면 된다」이고 `playHand(final, '최후', 5)`다. 셋이 되었으므로 인원과 근거를 같이 고친다.

```ts
    } else {
      // 최후 1인까지 친다. **셋이 남아 있으므로 한 판이면 된다** — 전원
      // 올인하고 딜러가 **순위를 끝까지 찍는다.** 층이 남으면 서버가 한 칩도
      // 움직이기 전에 거부하는데, 여기서는 그 층이 곧 2·3위 상금이다.
      mark('마무리 — 최후 1인');
      await playHand(final, '최후', 3);
```

- [ ] **Step 4: 타입 체크**

Run: `npm run typecheck`
Expected: 타입 에러 0.

**촬영은 여기서 안 돌린다.** 한 번이 14분이고, Task 3·4가 같은 파일을 더 고친다. Task 5가 셋을 한꺼번에 검증하는 게이트다.

- [ ] **Step 5: 커밋**

```bash
git add frontend/e2e/demo/settlement.spec.ts
git commit -m "test: 대기를 맨 뒤로 밀고 파이널 테이블에 셋을 남긴다

병합을 마감 앞으로 옮겼다. `releaseSeats`가 요구하는 것은 WAITING뿐이고
마감을 요구하는 것은 `isFinalTable` 하나라, 마감 전에 합쳐도 ICM의 문만
안 열린다. 앞에 두면 리바인과 좌석 이동 사이에 8분이 껴 그 둘을 한
프레임으로 못 붙였다.

마지막 판을 넷 올인으로 바꿔 셋이 남게 했다. 마무리 프레임의 폰 셋이
「남은 전원」이 되어 고르는 임의성이 없어지고, 이미 나간 상금이 셋
(6·5·4위)이라 확인 대화의 「남은 상금」이 걷은 돈과 갈린다."
```

---

## Task 3: 면을 늘린다 — 딜러 넷 · 배역을 T3·T4로 · 폰 둘

프레임 ①과 ②가 요구하는 면을 연다.

**Files:**
- Modify: `frontend/e2e/demo/settlement.spec.ts`

**Interfaces:**
- Consumes: Task 2의 마크 이름
- Produces: 영상 파일 이름 — `dealer-t1` · `dealer-t2` · `dealer-t3` · `dealer-t4` · `scoreboard` · `console` · `seat-rebuyer` · `seat-mover` · `phone-rebuyer` · `phone-mover`. Task 6의 `tile()`이 이 이름을 가리킨다.

- [ ] **Step 1: 배역을 T3·T4로 옮긴다**

지금 `ON_SCREEN = { survivor: 'A1', rebuyer: 'A5' }`로 둘 다 1번 테이블이다. 시드의 닉네임이 `A1`~`D8`이고 접두사가 테이블이므로(`SETTLEMENT_PLAYERS`), 3번은 `C`, 4번은 `D`다.

```ts
/**
 * 화면으로 앉는 둘. **서로 다른 테이블이다.**
 *
 * 둘 다 촬영 테이블에 두면 병합 장면에서 **아무도 걸어오지 않는다** — 이
 * 촬영이 보여주려는 것이 「사람이 칩을 들고 걸어간다」인데 그 걸음이
 * 화면 밖에서 일어난다.
 *
 * 리바인하는 사람을 **C(3번)에 둔다.** 그 수락이 엔트리를 36으로 만들고
 * 전광판의 상금 목록이 늘어나는데, **원인(딜러 타일의 스택 부활)과
 * 결과(전광판)가 한 프레임에 있어야** 인과가 읽힌다.
 *
 * 다른 하나는 **D(4번)**다. 병합①이 `C→A`, `D→B`라 **둘이 서로 다른
 * 테이블로 흩어진다** — 하나면 「이 사람이 옮겼다」이고, 둘이면 「테이블이
 * 합쳐지는 중이다」가 된다.
 */
const ON_SCREEN = { rebuyer: 'C5', mover: 'D5' } as const;
```

`survivor`를 쓰던 자리를 전부 `mover`로 바꾼다 — `survivorTablet` → `moverTablet`, `stage('tablet', 'seat-survivor')` → `stage('tablet', 'seat-mover')`.

- [ ] **Step 2: 딜러 넷을 다 화면으로 연다**

지금은 촬영 테이블(`FILMED_TABLE`)만 화면이고 셋은 소켓이다. **넷 다 화면을 열되 누르는 것은 계속 소켓이 한다.**

```ts
    // ── 딜러 넷 ─────────────────────────────────────────────────────
    //
    // **넷 다 화면을 연다. 그런데 누르는 것은 셋이 여전히 소켓이다.**
    //
    // 게이트웨이가 테이블 접속자 **전원**에게 `renderGame`을 뿌리므로
    // (`WsGateway`), 태블릿은 붙어 있기만 해도 판이 도는 것을 그린다. 조작을
    // 화면으로 옮기면 `slowMo`가 클릭마다 붙어 촬영이 몇 배로 늘어나는데,
    // 프레임 ①이 보여주려는 것은 「세 테이블에서 동시에 사람이 사라진다」라
    // 누르는 손이 아니라 **줄어드는 펠트**다.
    //
    // 비용은 컨텍스트 셋이다. 1280×720이고 녹화가 붙지만, 이 셋이 없으면
    // 규모가 화면에 나타날 자리가 전광판의 숫자뿐이다.
    mark('무대 — 딜러 넷이 각자의 테이블에 붙는다');
    const dealerTablets = new Map<number, Page>();
    for (const { tableOrder, id } of settlement.tables) {
      const page = await stage('tablet', `dealer-t${tableOrder}`);
      await enterDealer(page, storeId, id, settlement.dealerOtp);
      dealerTablets.set(tableOrder, page);
    }
    const dealerTablet = dealerTablets.get(FILMED_TABLE)!;
```

`stages`를 만드는 루프는 그대로 둔다 — `dealer`는 촬영 테이블만 `kind: 'screen'`이고 나머지는 소켓이다. 태블릿은 **보기만 하는 면**이라 `Stage`에 안 들어간다.

- [ ] **Step 3: 폰 둘을 연다**

프레임 ②가 요구하는 면이다. 착석이 끝난 뒤, 병합 직전에 연다.

```ts
    // ── 폰 둘 ───────────────────────────────────────────────────────
    //
    // **병합 장면의 절반이 폰에 있다.** 좌석을 잃은 사람이 새 자리에 앉으려면
    // 참가 OTP가 필요한데, 그것을 다시 보는 자리가 폰의 `/me`다 — 처음 앉을
    // 때 쓴 것과 **같은 번호**라는 것이 이 흐름의 요점이고, 그 사실은 폰이
    // 화면에 있어야 보인다.
    //
    // 둘을 여는 이유는 둘이 다른 테이블로 흩어지기 때문이다(`ON_SCREEN`).
    const rebuyerPhone = await stage('phone', 'phone-rebuyer');
    const moverPhone = await stage('phone', 'phone-mover');
    await openWithToken(
      rebuyerPhone,
      await login(request, ON_SCREEN.rebuyer, manifest.password),
      '/me',
    );
    await openWithToken(
      moverPhone,
      await login(request, ON_SCREEN.mover, manifest.password),
      '/me',
    );
```

- [ ] **Step 4: 두 사람만 화면으로 옮긴다**

`mergeInto`는 그대로 두고, **화면 배역 둘만** 갈라낸다. 나머지 열넷은 REST가 옮긴다.

```ts
    /**
     * 화면으로 옮긴다. **상점이 좌석을 풀고, 사람이 폰을 보고, 태블릿에
     * 번호를 넣는다.**
     *
     * `mergeInto`가 REST로 하는 것과 **같은 일**이다. 다른 것은 그 셋이 각각
     * 다른 손의 일이라는 사실이 화면에 남는다는 것뿐이다 — 온라인이면 서버가
     * 좌석을 재배치하고 끝이지만 여기서는 사람이 칩을 들고 걸어간다.
     *
     * 열여섯을 전부 이렇게 옮기지 않는다. `slowMo`가 붙은 키패드 여덟 자리가
     * 열여섯 번이면 촬영이 그만큼 늘어나고, 보이는 것은 같은 조작의 반복이다.
     */
    const walkOnScreen = async (opts: {
      tablet: Page;
      phone: Page;
      from: Stage;
      into: Stage;
      nickname: string;
      seatIndex: number;
      otp: string;
    }) => {
      // 1. 상점이 좌석을 뗀다. 칩은 참가에 붙어 있어 그대로 남는다(T29).
      await press(
        console_,
        console_.getByRole('button', { name: `${opts.nickname} 좌석 해제` }),
      );
      // 2. 사람이 폰에서 참가 OTP를 다시 본다. 처음과 같은 번호다.
      await opts.phone.bringToFront();
      await opts.phone.reload();
      await linger(opts.phone, 2_500);
      // 3. 새 자리 태블릿에 그 번호를 넣는다.
      await sitDown(opts.tablet, storeId, opts.into.tableId, opts.seatIndex, opts.otp);
    };
```

버튼 이름(`${nickname} 좌석 해제`)이 `ConsoleClient`가 실제로 그리는 접근 가능한 이름과 다르면 여기서 멈춘다. **`ConsoleClient`의 좌석 도식에서 그 버튼이 어떤 이름으로 그려지는지 읽고 맞춘다** — 다르면 이 코드가 아니라 실제 이름을 따른다.

- [ ] **Step 5: 병합①에서 두 배역을 화면으로 태운다**

`mergeInto`에 화면 배역을 하나 받는 인자를 더한다. **나머지는 지금 그대로 REST다.**

```ts
    /**
     * @param onScreen 이 테이블에서 **화면으로** 옮길 사람. 없으면 전부 REST다.
     */
    const mergeInto = async (
      from: Stage,
      into: Stage,
      onScreen?: { nickname: string; tablet: Page; phone: Page },
    ) => {
      await settleToWaiting(from, '병합');
      const source = await stateOf(from);
      const moving = source.players
        .map((p, i) => (p ? { seatIndex: i, id: p.id, nickname: p.nickname } : null))
        .filter((v): v is { seatIndex: number; id: string; nickname: string } => v !== null);

      // **화면 배역을 먼저 뗀다.** 상점이 콘솔에서 그 한 자리를 푸는 것이
      // 이 장면의 첫 박자다. 벌크 해제에 섞으면 그 조작이 화면에 안 남는다.
      const star = onScreen ? moving.find((m) => m.nickname === onScreen.nickname) : undefined;
      if (onScreen && !star) {
        throw new Error(`${onScreen.nickname}이 ${from.tableOrder}번 테이블에 없다.`);
      }
      if (onScreen && star) {
        await console_.bringToFront();
        await releaseSeatOnScreen(console_, from.tableId, star.seatIndex, star.nickname);
      }

      // 나머지는 REST로 한꺼번에. 열넷을 키패드로 태우면 촬영이 그만큼
      // 늘어나고 보이는 것은 같은 조작의 반복이다.
      const rest = moving.filter((m) => m.seatIndex !== star?.seatIndex);
      if (rest.length > 0) {
        const res = await request.post(
          `http://localhost:3001/store/sessions/${tournamentId}/tables/${from.tableId}/seats/release`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            data: { seats: rest.map((m) => ({ seatIndex: m.seatIndex, userId: m.id })) },
          },
        );
        if (!res.ok()) {
          throw new Error(`좌석 해제 실패 (${from.tableOrder}번): ${res.status()} ${await res.text()}`);
        }
      }

      for (const m of moving) {
        const actor = from.seats.get(m.seatIndex)!;
        if (actor.kind === 'wire') await actor.wire.close();
        from.seats.delete(m.seatIndex);

        const taken = new Set((await stateOf(into)).players.map((p, i) => (p ? i : -1)));
        const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((i) => !taken.has(i));
        if (free === undefined) throw new Error(`${into.tableOrder}번 테이블에 빈 자리가 없다.`);

        if (onScreen && m.seatIndex === star?.seatIndex) {
          // **폰을 보고 태블릿에 넣는다.** 처음 앉을 때 쓴 것과 같은 참가
          // OTP라는 것이 이 흐름의 요점이고, 그 사실은 폰이 화면에 있어야
          // 보인다.
          await onScreen.phone.bringToFront();
          await onScreen.phone.reload();
          await linger(onScreen.phone, 2_500);
          await sitDown(onScreen.tablet, storeId, into.tableId, free, playerOf(m.nickname).otp);
          into.seats.set(free, { kind: 'screen', page: onScreen.tablet });
          continue;
        }

        await seat(request, tournamentId, {
          tableId: into.tableId,
          seatIndex: free,
          otp: playerOf(m.nickname).otp,
        });
        into.seats.set(free, {
          kind: 'wire',
          wire: await openSeatWire(m.nickname, into.tableId),
        });
      }

      // 아래(테이블 닫기 · `stages.delete` · 딜러 소켓 닫기)는 지금 그대로다.
      // ...
    };
```

부르는 자리:

```ts
    await mergeInto(stages.get(3)!, stages.get(FILMED_TABLE)!, {
      nickname: ON_SCREEN.rebuyer,
      tablet: rebuyerTablet,
      phone: rebuyerPhone,
    });
    await mergeInto(stages.get(4)!, stages.get(2)!, {
      nickname: ON_SCREEN.mover,
      tablet: moverTablet,
      phone: moverPhone,
    });
```

`releaseSeatOnScreen`은 새로 쓴다. **`ConsoleClient`가 좌석 도식에서 그 버튼을 어떤 접근 가능한 이름으로 그리는지 먼저 읽고 맞춘다** — 아래 선택자는 추정이고, 실제 이름이 다르면 실제 것을 따른다.

```ts
/**
 * 상점이 콘솔에서 좌석 하나를 뗀다.
 *
 * REST 한 번이면 될 일을 화면으로 하는 이유는 **그 조작이 사람의 일이라는
 * 것이 이 장면의 내용**이기 때문이다. 온라인이면 서버가 좌석을 재배치하고
 * 끝이지만, 여기서는 상점이 자리를 풀고 사람이 칩을 들고 걸어간다.
 */
async function releaseSeatOnScreen(
  page: Page,
  tableId: string,
  seatIndex: number,
  nickname: string,
) {
  await page.getByRole('tab', { name: new RegExp(String(tableId.slice(-4))) }).click().catch(() => {});
  const cell = page.getByTestId(`seat-${seatIndex}`);
  await expect(cell).toContainText(nickname, { timeout: 15_000 });
  await press(page, cell.getByRole('button', { name: '좌석 해제' }));
  await expect(cell).not.toContainText(nickname, { timeout: 15_000 });
}
```

성공 조건이 **「눌렀다」가 아니라 「그 자리에서 이름이 사라졌다」**인 것에 주의한다(`e2e/README.md`).

딜러 태블릿 T3·T4는 그 테이블이 닫히면서 오류 화면이 된다. **프레임 ①의 창이 `병합` 마크에서 끝나므로 영상에 안 남는다.** 남는다면 창이 잘못 잡힌 것이다.

- [ ] **Step 6: 타입 체크**

Run: `npm run typecheck`
Expected: 타입 에러 0.

- [ ] **Step 7: 커밋**

```bash
git add frontend/e2e/demo/settlement.spec.ts
git commit -m "test: 면을 열둘로 늘려 프레임 하나에 인과가 다 들어가게 한다

딜러 넷을 다 화면으로 연다. 누르는 것은 셋이 여전히 소켓이다 —
게이트웨이가 테이블 접속자 전원에게 renderGame을 뿌리므로 태블릿은 붙어만
있어도 판이 도는 것을 그리고, 프레임 ①이 보여주려는 것은 누르는 손이
아니라 줄어드는 펠트다.

화면 배역 둘을 서로 다른 테이블(C·D)로 옮겼다. 둘 다 촬영 테이블에 두면
병합 장면에서 아무도 걸어오지 않는다. 리바인하는 사람을 C에 둔 것은
원인(딜러 타일의 스택 부활)과 결과(전광판)가 한 프레임에 있어야 해서다.

폰 둘을 열어 참가 OTP 재조회를 화면에 남긴다. 처음 앉을 때 쓴 것과 같은
번호라는 사실이 이 흐름의 요점이고, 그것은 폰이 화면에 있어야 보인다."
```

---

## Task 4: 마무리 폰 셋

프레임 ③의 아래 행이다.

**Files:**
- Modify: `frontend/e2e/demo/settlement.spec.ts`

**Interfaces:**
- Consumes: Task 3의 `stage` 사용 방식
- Produces: 영상 파일 이름 `phone-final-1` · `phone-final-2` · `phone-final-3`

- [ ] **Step 1: 최종 셋이 정해진 뒤에 폰을 연다**

`셋만 남는다` 뒤, `마무리 — 셋이 한 화면에 있다` 앞에 넣는다.

```ts
    // ── 남은 셋의 폰 ────────────────────────────────────────────────
    //
    // **여기서 연다. 앞에서는 누가 남을지 모른다.**
    //
    // 남는 셋은 결정적이지만(`planHand`가 스택 최대를 이기게 한다) 그 값은
    // 판을 돌려 봐야 나온다. `stage()`는 테스트 도중 언제든 부를 수 있고,
    // 늦게 연 면의 앞부분은 자르는 쪽이 검게 채운다
    // (`make-demo-assets.mjs`의 `tpad`).
    //
    // **폰이 마무리 프레임의 절반이다.** 콘솔의 장부는 상점이 보는 숫자이고,
    // 그 돈이 실제로 사람에게 갔는지는 폰이 말한다 — `/me`의 지난 참가에
    // 등수와 상금이 그 사람 몫으로 찍힌다.
    const survivors = (await stateOf(final)).players
      .map((p, seatIndex) => (p ? { seatIndex, nickname: p.nickname } : null))
      .filter((p): p is { seatIndex: number; nickname: string } => p !== null);
    expect(`남은 인원 ${survivors.length}`).toBe('남은 인원 3');

    const finalPhones: Page[] = [];
    for (const [i, who] of survivors.entries()) {
      const page = await stage('phone', `phone-final-${i + 1}`);
      await openWithToken(page, await login(request, who.nickname, manifest.password), '/me');
      finalPhones.push(page);
    }
```

`expect`로 인원을 못 박는 이유: 셋이 아니면 프레임 ③의 타일 수가 안 맞아 자르는 쪽이 죽는데, **그 실패는 44분 뒤에 온다.** 여기서 멈추면 14분이다.

- [ ] **Step 2: 대회가 닫힌 뒤 폰을 새로고침한다**

`mark('끝')` 앞, `shoot(console_, CLOSED_SHOT[ENDING])` 뒤에 넣는다.

```ts
    // **닫힌 뒤에 다시 읽는다.** `/me`의 지난 참가는 폴링이 아니라 한 번
    // 받아 그린 값이라, 대회가 닫히기 전에 연 폰은 등수도 상금도 비어 있다.
    // 상금은 `awardPrize`가 그 자리에서 `finalPlace`를 박을 때 생긴다.
    for (const page of finalPhones) {
      await page.bringToFront();
      await page.reload();
      await linger(page, 2_000);
    }
```

`bringToFront()`를 도는 이유는 렌더가 멈춘 면에서 프레임이 안 나오기 때문이다 — 커서 하트비트가 있지만(`cursor.ts`) 새로고침 직후의 그림이 영상에 남아야 한다.

- [ ] **Step 3: 타입 체크**

Run: `npm run typecheck`
Expected: 타입 에러 0.

- [ ] **Step 4: 커밋**

```bash
git add frontend/e2e/demo/settlement.spec.ts
git commit -m "test: 남은 셋의 폰을 열어 돈이 사람에게 간 것을 남긴다

최종 셋이 정해진 뒤에 연다. 남는 사람은 결정적이지만 판을 돌려야 나오는
값이고, 늦게 연 면의 앞부분은 자르는 쪽이 검게 채운다.

인원을 셋으로 못 박는다. 아니면 마무리 프레임의 타일 수가 안 맞아 자르는
쪽이 죽는데 그 실패는 44분 뒤에 온다. 여기서 멈추면 14분이다.

대회가 닫힌 뒤 새로고침한다. `/me`의 지난 참가는 한 번 받아 그린 값이라
닫히기 전에 연 폰은 등수도 상금도 비어 있다."
```

---

## Task 5: 촬영 — 여기가 게이트다

Task 2·3·4는 타입 체크만 통과한 상태다. **촬영이 이 셋을 한꺼번에 검증한다.**

**Files:** 없음. 명령만 돌린다.

- [ ] **Step 1: 남은 playwright 프로세스가 없는지 본다**

Run (PowerShell):
```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'playwright' }
```

Expected: 출력 없음.

**출력이 있으면 죽이고 다시 확인한다.** 세 실행이 같은 DB에서 동시에 돌면 진단이 통째로 어긋나고, 그것을 알아채는 데 12분이 든다.

- [ ] **Step 2: 하나만 먼저 돌린다**

Run: `node scripts/demo-settlement.mjs --only=complete`

Expected: 통과. ~14분.

**여기서 셋 다 돌리지 않는다.** Task 2·3·4가 처음 함께 도는 자리라 깨질 확률이 가장 높고, 셋을 돌리면 실패를 44분 뒤에 안다.

자주 나오는 실패와 뜻:

| 메시지 | 무엇 |
|---|---|
| `남은 인원 N` (N ≠ 3) | Task 2의 `playHand(final, '셋만', 4)`가 예상과 다르게 죽였다. 미콜 환급을 의심한다 |
| `... 자리의 손이 없다. 차례가 멈춘다` | Task 3에서 좌석 배역을 옮기며 `stages`의 `seats` 등록이 빠졌다 |
| `좌석 해제` 버튼을 못 찾음 | Task 3 Step 4의 버튼 이름이 `ConsoleClient`가 그리는 것과 다르다 |
| 타임아웃 30분 | `actionTimeout`이 안 걸린 조작이 있다. `playwright.config.ts` 확인 |

- [ ] **Step 3: 마크가 다 찍혔는지 본다**

Run:
```bash
node -e "const t=require('./frontend/e2e/recordings/마무리-최후-1인/timeline.json'); console.log(t.marks.map(m=>m.name).join('\n'))"
```

폴더 이름은 `TAKE_TITLE.complete`가 정한다 — 실제 이름은 `ls frontend/e2e/recordings/`로 확인한다.

Expected: Task 2의 마크 목록이 그 순서대로. **`셋만 남는다 — 상금이 세 번 나간다`가 `마감 — 상금이 예상에서 확정으로 바뀐다` 뒤에 있어야 한다.**

여기서 어긋나면 Task 6의 자르기가 죽는다. **44분을 쓰기 전에 잡는다.**

- [ ] **Step 4: 면이 다 열렸는지 본다**

Run: `ls frontend/e2e/recordings/<폴더>/*.webm`

Expected: 열둘. `console` · `scoreboard` · `dealer-t1`~`dealer-t4` · `seat-rebuyer` · `seat-mover` · `phone-rebuyer` · `phone-mover` · `phone-final-1`~`phone-final-3`.

**`complete` 실행에는 `phone-final-*`이 셋 다 있어야 한다.** 없으면 Task 4 Step 1이 안 돌았다.

- [ ] **Step 5: 나머지 둘을 돌린다**

Run:
```bash
node scripts/demo-settlement.mjs --only=chop --no-build
node scripts/demo-settlement.mjs --only=abort --no-build
```

Expected: 둘 다 통과. ~28분.

`--no-build`는 Step 2가 이미 빌드했기 때문이다.

- [ ] **Step 6: 세 실행의 남은 셋이 같은 사람인지 본다**

프레임 ③이 「같은 사람의 다른 결말」을 주장하므로, **다르면 그 프레임이 거짓이 된다.**

Run: 세 폴더의 `phone-final-*.webm` 파일 이름은 순번뿐이라 이것으로는 못 본다. 대신 실행 로그의 `[장면]` 줄과 콘솔 장부 스틸(`19-chop-ledger-sums.png` · `22-closed-complete.png`)에 찍힌 닉네임을 눈으로 맞춘다.

어긋나면 **원인이 시드가 아니라 시계다** — 실행마다 갈림목에 다른 블라인드 레벨로 도착하면 스택 분포가 갈린다. `SETTLEMENT_BLIND_STRUCTURE`의 레벨 2가 90분인 것이 그것을 막는 장치이므로, 어긋났다면 촬영이 레벨 2를 넘긴 것이다.

- [ ] **Step 7: 커밋할 것이 없다**

촬영 산출물은 `frontend/e2e/recordings/`이고 git이 무시한다. **다음 태스크로 넘어가되 이 폴더들을 지우지 않는다** — Task 6이 셋을 다 읽는다.

---

## Task 6: 자르는 쪽이 실행을 가로지르게 한다

프레임 ③이 `chop`과 `complete` 두 실행을 좌우로 놓는다. 지금 `buildScene`은 폴더 하나만 받는다.

**Files:**
- Modify: `scripts/make-demo-assets.mjs`

**Interfaces:**
- Consumes: Task 2의 마크 이름, Task 3·4의 영상 파일 이름
- Produces: `img/`에 들어갈 움짤 넷 — `03-four-tables-to-one.webp` · `05-two-doors-same-ledger.webp` · `11-entry-not-player.webp` · `20-abort-refunds-all.webp`

- [ ] **Step 1: `tile()`이 실행을 받게 한다**

지금:
```js
function tile(label, width, height) {
  return { label, width, height };
}
```

바꿈:
```js
/**
 * 타일 하나. **`take`를 주면 다른 촬영 실행에서 가져온다.**
 *
 * 마무리 프레임이 `chop`과 `complete`를 좌우로 놓는다. 같은 시드에서 돌아
 * 갈림목 전까지 숫자가 같고, 파이널 테이블에 남는 셋도 같다 — 그래서 좌우가
 * **같은 사람의 다른 결말**이 된다. 그 그림을 만들려면 타일마다 다른 폴더와
 * 다른 `timeline.json`을 봐야 한다.
 *
 * `take`를 안 주면 장면이 정한 기본 실행이다. 프레임 하나가 한 실행에서
 * 나오는 것이 여전히 보통이다.
 */
function tile(label, width, height, take) {
  return { label, width, height, take };
}
```

- [ ] **Step 2: `buildScene`이 타일마다 타임라인을 보게 한다**

지금 서명은 `buildScene(dir, timeline, scene)`이고 `dir`/`timeline`을 모든 타일이 공유한다.

```js
/**
 * 장면 하나를 자른다.
 *
 * **타일마다 시계가 다르다.** 면마다 0초가 다르다는 것은 처음부터 그랬고
 * (`surfaces.ts`의 슬레이트), 여기에 **실행마다 0초가 다르다**가 더해졌다.
 * 그래서 `from`/`to`는 이름으로 두고, 그 이름이 몇 초인지는 **그 타일이 속한
 * 실행의 `timeline.json`**에서 각자 읽는다.
 *
 * 길이가 어긋나면 `tpad`이 뒤를 채운다. 실행 둘의 마무리 구간이 같은 초일
 * 이유가 없고, **`hstack`은 가장 짧은 입력에서 끝난다** — 채우지 않으면 긴
 * 쪽의 뒷부분이 통째로 잘린다.
 */
function buildScene(scene, takes) {
  // 이 장면이 건드리는 실행마다 구간을 먼저 잰다. 타일이 여섯이어도 실행은
  // 둘이므로, 타일마다 다시 재면 같은 값을 여러 번 읽는다.
  const used = new Set(scene.rows.flat().map((t) => t.take ?? scene.take));
  const spans = new Map();
  for (const name of used) {
    const entry = takes.get(name);
    if (!entry) throw new Error(`${scene.out}: "${name}" 촬영이 없다.`);
    spans.set(name, {
      start: markAt(entry.timeline, scene.from),
      end: markAt(entry.timeline, scene.to),
    });
  }

  // 가장 긴 구간에 맞춘다. 짧은 쪽은 마지막 프레임을 늘려 채운다.
  const longest = Math.max(...[...spans.values()].map((s) => s.end - s.start));

  const inputs = [];
  const filters = [];

  const rowWidths = scene.rows.map((row) => row.reduce((w, t) => w + t.width, 0));
  if (new Set(rowWidths).size > 1) {
    throw new Error(`${scene.out}: 행마다 폭이 다르다 (${rowWidths.join(' · ')}).`);
  }

  let n = 0;
  const rowLabels = [];
  scene.rows.forEach((row, r) => {
    const cells = [];
    for (const t of row) {
      const takeName = t.take ?? scene.take;
      const { dir, timeline } = takes.get(takeName);
      const { start, end } = spans.get(takeName);

      const file = join(dir, `${t.label}.webm`);
      if (!existsSync(file)) throw new Error(`영상이 없다: ${file}`);
      inputs.push('-i', file);

      const surface = surfaceEntry(timeline, t.label, file);
      const from = toVideoTime(surface, start);
      const to = toVideoTime(surface, end);
      // 면이 그 장면 도중에 열렸으면 앞부분은 검은 화면으로 채운다 — 그
      // 순간의 그림이 아예 없다. 마무리 프레임의 폰이 그렇다(최종 셋이
      // 정해진 뒤에 열린다).
      const lead = Math.max(0, Math.min(surface.openedAt, end) - start);
      // 이 실행의 구간이 가장 긴 것보다 짧으면 뒤를 늘린다.
      const tail = longest - (end - start);

      filters.push(
        `[${n}:v]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS,` +
          `tpad=start_duration=${lead.toFixed(3)}:start_mode=add:color=black` +
          `:stop_duration=${tail.toFixed(3)}:stop_mode=clone,` +
          `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=w='max(iw,${t.width})':h='max(ih,${t.height})':x=(ow-iw)/2:y=(oh-ih)/2:color=black,` +
          `crop=${t.width}:${t.height},` +
          `drawbox=x=0:y=0:w=iw:h=ih:t=2:color=0x3d3d3d@1,setsar=1[t${n}]`,
      );
      cells.push(`[t${n}]`);
      n += 1;
    }

    if (cells.length === 1) {
      rowLabels.push(cells[0]);
      return;
    }
    filters.push(`${cells.join('')}hstack=inputs=${cells.length}[r${r}]`);
    rowLabels.push(`[r${r}]`);
  });

  let grid = rowLabels[0];
  if (rowLabels.length > 1) {
    filters.push(`${rowLabels.join('')}vstack=inputs=${rowLabels.length}[g]`);
    grid = '[g]';
  }
  filters.push(`${grid}fps=${scene.fps},scale=${scene.width}:-2:flags=lanczos[out]`);

  // 아래(ffmpeg 호출과 출력 경로)는 지금 구현 그대로다.
  const out = join(ASSETS, `${scene.out}.webp`);
  ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:v', 'libwebp_anim', /* 나머지 인자 그대로 */]);
  console.log(`  ${scene.out}.webp  ${mib(out)}MB`);
}
```

`stop_mode=clone`은 마지막 프레임을 복제한다. 마무리 구간의 끝은 대회가 닫힌 뒤 정지에 가까운 화면이라, 늘어난 몇 초가 그림을 바꾸지 않는다. `stop_duration=0`은 아무 일도 안 하므로 가장 긴 실행에는 무해하다.

**`scene.take`가 그 장면의 기본 실행이다.** 프레임 ①·②는 `'complete'`, abort는 `'abort'`, 프레임 ③은 기본이 `'chop'`이고 우열 타일만 `take: 'complete'`를 단다.

호출하는 자리도 같이 고친다.

```js
// 지금
for (const scene of scenes) buildScene(dir, timeline, scene);
// 바꿈
for (const scene of scenes) buildScene(scene, takes);
```

- [ ] **Step 3: `settlementScenes`를 프레임 넷으로 다시 쓴다**

```js
/**
 * 정산 촬영이 내놓는 움짤 넷.
 *
 * **실행마다 다시 만들지 않는다.** 갈림목 전까지 세 실행이 똑같으므로
 * 프레임 ①·②는 `complete` 하나에서만 자른다 — 전에는 마무리마다 같은 그림을
 * 셋씩 만들고 이름만 달랐다.
 *
 * 배치의 근거는 설계 문서에 있다
 * (`docs/superpowers/specs/2026-08-24-settlement-demo-design.md` §4).
 * 여기 숫자와 저 표가 어긋나면 저쪽이 맞다.
 */
function settlementScenes() {
  return [
    {
      // **엔트리는 사람 수가 아니다.** 배경 테이블 셋에서 다섯씩 사라지고,
      // 리바인 하나가 상금권을 다섯 줄에서 여섯 줄로 올린다. 그때 사람은
      // 35 그대로다.
      //
      // 수락을 누르는 손은 이 프레임에 없다 — 좌석 태블릿의 일이라
      // `12-rebuy-accept-raises-entry.png`가 README에서 옆에 붙는다.
      out: '11-entry-not-player',
      take: 'complete',
      from: '첫 판 — 한 판에 여섯이 올인한다',
      to: '병합 — 네 테이블이 둘이 된다',
      rows: [
        [tile('dealer-t1', 880, 495), tile('dealer-t2', 880, 495)],
        [tile('dealer-t3', 880, 495), tile('scoreboard', 880, 495)],
      ],
      fps: 6,
      width: 1100,
    },
    {
      // **필드가 넷에서 하나로.** 자동이 아니다 — 상점이 좌석을 풀고, 사람이
      // 폰에서 참가 OTP를 다시 보고, 새 태블릿에 그 번호를 넣는다.
      //
      // 폰이 둘인 것은 둘이 서로 다른 테이블로 흩어지기 때문이다.
      out: '03-four-tables-to-one',
      take: 'complete',
      from: '병합 — 네 테이블이 둘이 된다',
      to: '둘째 판 — 두 테이블에서 열이 나간다',
      rows: [
        [tile('seat-rebuyer', 880, 495), tile('seat-mover', 880, 495)],
        [tile('console', 1180, 738), tile('phone-rebuyer', 290, 738), tile('phone-mover', 290, 738)],
      ],
      fps: 6,
      width: 1100,
    },
    {
      // **두 문, 같은 등식.** 왼쪽은 콘솔에서 합의한 숫자를 적고, 오른쪽은
      // 테이블에서 끝까지 쳐서 정한다 — 딜은 콘솔의 일이고 승부는 펠트의
      // 일이다. 아래는 같은 셋의 폰이고, 찍힌 금액만 다르다.
      //
      // **이 장면만 실행을 가로지른다.**
      out: '05-two-doors-same-ledger',
      take: 'chop',
      from: '마무리 — 셋이 한 화면에 있다',
      to: '끝',
      rows: [
        [tile('console', 880, 550), tile('dealer-t1', 880, 550, 'complete')],
        [
          tile('phone-final-1', 293, 634), tile('phone-final-2', 293, 634), tile('phone-final-3', 294, 634),
          tile('phone-final-1', 293, 634, 'complete'), tile('phone-final-2', 293, 634, 'complete'), tile('phone-final-3', 294, 634, 'complete'),
        ],
      ],
      fps: 5,
      width: 1100,
    },
    {
      // **중단하면 상점 몫이 0이 된다.** 등식의 오른쪽 항 셋이 한 화면에
      // 다 나오는 유일한 문이다. 환불이 사람마다가 아니라 무리로 접히는
      // 것(진행 중 · 탈락 · 이미 상금을 받은 사람)이 표에 그대로 있다.
      out: '20-abort-refunds-all',
      take: 'abort',
      from: '마무리 — 셋이 한 화면에 있다',
      to: '끝',
      rows: [[tile('console', 880, 550), tile('scoreboard', 880, 550)]],
      fps: 5,
      width: 1100,
    },
  ];
}
```

- [ ] **Step 4: 진입점을 하나로 바꾼다**

지금은 `--settlement=<ending>`으로 마무리마다 부른다. **셋이 다 있어야 자를 수 있으므로 한 번만 부른다.**

```js
/**
 * 어느 촬영을 자를지. 기본값은 장면 1~5다.
 *
 * `--settlement`은 정산 촬영을 자른다. **인자를 안 받는다** — 마무리 프레임이
 * `chop`과 `complete`를 좌우로 놓으므로 **셋이 다 있어야** 자를 수 있고,
 * 하나만 골라 자를 수 있게 두면 「반만 있는 그림」이 조용히 나온다.
 */
const isSettlement = process.argv.includes('--settlement');
```

정산이면 세 실행을 다 로드한다.

```js
const takes = new Map();
if (isSettlement) {
  for (const [ending, take] of Object.entries(SETTLEMENT_TAKE)) {
    takes.set(ending, loadTimeline(take));
  }
} else {
  takes.set('main', loadTimeline(TAKE));
}
const scenes = isSettlement ? settlementScenes() : SCENES.map((s) => ({ ...s, take: 'main' }));
const stills = isSettlement
  ? Object.keys(SETTLEMENT_TAKE).flatMap((e) => settlementStills(e))
  : STILLS;
```

`loadTimeline`의 오류 메시지에 「셋 다 필요하다」를 더한다 — 하나가 없을 때 사람이 무엇을 다시 돌려야 하는지가 그 메시지에만 있다.

`package.json`의 `assets:settlement`도 인자 없는 형태로 고친다.

- [ ] **Step 5: 마크가 다 있는지 먼저 본다**

마크가 없으면 `markAt`이 던진다. **던지기 전에 무엇이 있는지 눈으로 본다** — 자르기는 ffmpeg를 여러 번 돌려 느리고, 이름 하나가 어긋난 것을 그 끝에서 알면 아깝다.

```bash
for d in frontend/e2e/recordings/마무리-*; do
  echo "── $d"
  node -e "console.log(require('./$d/timeline.json').marks.map(m=>m.name).join('\n'))"
done
```

Expected: 세 폴더 다 Task 2의 마크 목록. 갈림목 마크만 폴더마다 다르다.

그 다음 자른다.

```bash
node scripts/make-demo-assets.mjs --settlement
```

Expected: 움짤 넷과 스틸이 `img/`에 떨어진다.

`장면 표시 "..."이 촬영 기록에 없다`가 뜨면 Task 2의 마크 이름과 여기 `from`/`to`가 어긋난 것이다. **촬영을 다시 돌리기 전에 이름부터 맞춘다.**

`행마다 폭이 다르다`가 뜨면 `rows`의 타일 폭 합이 행마다 달라진 것이다. 프레임 ③의 아래 행은 `293×4 + 294×2 = 1760`이라 위 행 `880×2 = 1760`과 같아야 한다.

- [ ] **Step 6: 나온 그림을 눈으로 본다**

Run: `ls -la img/*.webp`

Expected: 넷 다 2MB 안쪽.

**넘으면 `fps`나 `width`를 줄인다.** 폰 타일은 정지에 가까워 거의 안 먹고, 용량은 콘솔과 딜러의 움직임에서 온다.

그리고 **실제로 열어 본다.** 프레임 ③의 좌우 폰에 서로 다른 금액이 찍혀 있는가, 두 콘솔 장부의 「걷은」이 같은가 — 이 촬영의 주장이 그것이다.

- [ ] **Step 7: 커밋**

```bash
git add scripts/make-demo-assets.mjs package.json
git commit -m "chore: 자르는 쪽이 촬영 실행을 가로지르게 한다

마무리 프레임이 chop과 complete를 좌우로 놓는다. 같은 시드라 갈림목 전까지
숫자가 같고 파이널 테이블에 남는 셋도 같아서, 좌우가 같은 사람의 다른
결말이 된다. 그 그림을 만들려면 타일마다 다른 폴더와 다른 timeline.json을
봐야 한다.

--settlement이 인자를 안 받게 했다. 셋이 다 있어야 자를 수 있는데 하나만
골라 자를 수 있게 두면 반만 있는 그림이 조용히 나온다.

프레임 ①·②는 complete 하나에서만 자른다. 갈림목 전까지 세 실행이 똑같은데
전에는 마무리마다 같은 그림을 셋씩 만들고 이름만 달랐다."
```

---

## Task 7: `img/`를 갈아 끼우고 잔재를 정리한다

**Files:**
- Modify: `img/` (새 움짤 넷 · 새 스틸 둘 추가, `s6`~`s9` 삭제)
- Modify: `scripts/check-image-names.mjs` (`UNNUMBERED`에서 `s6`~`s9` 제거)

**`README.md`는 안 건드린다.** 이 브랜치는 자산이 제대로 나오는 데까지다.

- [ ] **Step 1: 새로 생긴 것을 확인한다**

Run: `git status --short img/`

Expected: `03-four-tables-to-one.webp` · `05-two-doors-same-ledger.webp` · `11-entry-not-player.webp` · `20-abort-refunds-all.webp` · `22-closed-complete.png` · `24-closed-abort.png`가 새로 있고, 개명된 것들이 갱신됐다.

- [ ] **Step 2: `s6`~`s9`를 지운다**

새 그림이 자리를 대신했으므로 이제 지운다.

```bash
git rm img/s6-six-all-in.webp img/s7-entry-not-player.webp img/s8-four-tables-to-one.webp img/s9-close-icm.webp
```

Modify: `scripts/check-image-names.mjs` — `UNNUMBERED`에서 그 넷을 뺀다.

- [ ] **Step 3: 나온 그림이 쓸 만한지 본다**

**README는 안 건드린다.** 이 브랜치의 목적은 **자산이 제대로 나오는 것**까지고, 어느 그림을 어느 층에 놓느냐는 그림을 다 보고 나야 서는 판단이라 별도 브랜치의 일이다(설계 문서 §2 · §5-6).

Run:
```bash
ls -la img/*.webp
node scripts/check-image-names.mjs
```

Expected: 움짤이 여덟(장면 1~5의 넷 + 정산 넷). 정산 넷이 각각 2MB 안쪽. 검사 통과.

그리고 **실제로 열어 본다.** 파일이 나온 것과 그림이 맞는 것은 다르다.

| 그림 | 눈으로 확인할 것 |
|---|---|
| `11-entry-not-player.webp` | 딜러 셋에서 사람이 사라지고, 전광판의 상금 줄이 다섯에서 여섯으로 는다 |
| `03-four-tables-to-one.webp` | 콘솔에서 좌석이 풀리고, 폰 둘이 참가 OTP를 다시 보이고, 두 사람이 다른 테이블에 앉는다 |
| `05-two-doors-same-ledger.webp` | **좌우 폰 여섯에 서로 다른 금액.** 두 콘솔 장부의 「걷은」이 같다 |
| `20-abort-refunds-all.webp` | 환불이 무리로 접히고 상점 몫이 0 |

- [ ] **Step 4: 회귀를 돌린다**

Run:
```bash
npm run typecheck
npm run test
```

Expected: 타입 에러 0. 단위 전부 통과.

Run: `npm run seed -w backend && npm run test:e2e`

Expected: 13건 통과.

`shoot()` 이름이 바뀌었지만 회귀 프로젝트는 스틸을 안 찍는다. **그래도 돌린다** — Task 3이 `settlement.spec.ts`를 크게 고쳤고, 같은 픽스처(`screen.ts` · `surfaces.ts`)를 회귀가 쓴다.

- [ ] **Step 5: 커밋**

```bash
git add img scripts/check-image-names.mjs
git commit -m "chore: 설계대로 자른 그림으로 갈아 끼운다

s6~s9를 지운다. 설계 없이 흐름대로 마크를 찍은 뒤 타일을 짐작한
것들이라 74초짜리 움짤에 5초짜리 주장이 들어 있었다. 11·03·05·20이
그 자리를 대신한다.

README는 손대지 않았다. 어느 그림을 어느 층에 놓느냐는 그림을 다 보고
나야 서는 판단이라 별도 브랜치의 일이다."
```
---

## 남은 것 — 메인이 한다

하위 에이전트의 몫이 아니다(`CLAUDE.md`의 「문서는 메인이 맡는다」).

1. **기준선을 실측한다.** 이 브랜치에서 `npm run typecheck` · `npm run test` · `npm run test:int` · `npm run test:e2e`를 돌려 숫자를 잰다. PR들이 각자 잰 숫자를 합산하지 않는다
2. **`CLAUDE.md`의 기준선과 명령어**를 고친다 — `assets:settlement`이 인자를 안 받게 됐다
3. **`frontend/e2e/README.md`의 「파일 이름이 그 그림의 주장이다」 절**을 새 규칙(`NN-<내용>`)으로 다시 쓴다
4. **`docs/handoff.md`를 지운다.** 임시 문서이고 여기 담긴 결정이 설계 문서로 옮겨 갔다
5. **PR을 연 뒤** `docs/tickets-audit.md`의 T84 상태 열을 `완료 (#번호)`로 고친다. 번호는 PR을 만들어야 안다
6. README 3층 재구성은 **다음 브랜치**
