// @ts-check
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';

/**
 * 촬영 원본(`frontend/e2e/recordings/`)을 README에 붙는 자산으로 만든다.
 *
 * 촬영은 **장면 다섯을 한 실행으로** 돈다. 좌석이 컨텍스트에 매여 있어
 * 나눌 수가 없기 때문이다(`e2e/demo/tournament.spec.ts` 머리글). 그래서
 * 자르는 일이 여기로 온다 — 경계는 스펙이 `timeline.json`에 시각으로 남겼다.
 *
 * **면마다 0초가 다르다. 그 시각을 영상 안에서 읽는다.**
 *
 * 촬영이 면을 열자마자 화면을 0.15초 자홍색으로 덮고 그 벽시계 시각을
 * 남긴다(`surfaces.ts`의 슬레이트). 여기서는 각 영상의 앞부분에서 그 색이
 * 나타나는 프레임을 찾아 "이 프레임이 그 시각"으로 못 박는다.
 *
 * 계산으로 맞추려던 두 번이 다 틀렸다. 컨텍스트를 연 시각은 인코더가 첫
 * 프레임을 쓰기까지의 지연만큼 흔들렸고, `닫힌 시각 − 파일 길이`는 파일을
 * 마무리하는 지연만큼 흔들렸다. 어느 쪽도 1초 안쪽으로 못 들어왔고, 그 1초가
 * 2×2 타일에서 **누르기도 전에 옆 화면이 먼저 바뀌는** 그림이 됐다.
 *
 * ffmpeg는 `ffmpeg-static`이다. Playwright도 ffmpeg를 번들로 갖고 있지만
 * `--disable-everything` 빌드라 **애니메이션 webp 인코딩과 hstack/vstack이
 * 없다.** 시스템에 설치하는 대신 개발 의존성으로 두면 리포와 함께 지워지고
 * CI에서도 같은 바이너리다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RECORDINGS = join(ROOT, 'frontend', 'e2e', 'recordings');
const SHOTS = join(ROOT, 'frontend', 'e2e', '.shots');
const ASSETS = join(ROOT, 'img');

/** 촬영 폴더 이름은 테스트 제목에서 나온다(`surfaces.ts`의 `slug`). */
const TAKE = '장면-1-5-한-대회';

/**
 * 장면 다섯.
 *
 * `from`/`to`는 `timeline.json`의 표시 이름이다. 이름을 그대로 쓰는 이유는
 * 숫자로 적으면 촬영을 다시 돌릴 때마다 여기를 고쳐야 하기 때문이다.
 *
 * `rows`가 곧 그 장면의 배치다. 명세 §5의 "화면" 칸과 같아야 한다.
 *
 * **타일 크기를 면마다 적는다.** 처음에는 전부 960×540에 끼웠는데, 폰만
 * 세로(390×844)라 검은 띠 안의 작은 그림이 됐다. 높이를 맞추고 폭은 각자
 * 비율대로 둔다 — 한 행 안에서 높이만 같으면 `hstack`이 붙고, 행끼리는
 * 폭이 같아야 `vstack`이 붙는다.
 *
 * fps는 장면마다 다르다. 긴 장면은 프레임을 줄여야 2MB 안에 든다.
 */
const SCENES = [
  {
    // **폰 → 태블릿 → 콘솔**이 한 사람을 가리키는 것이 이 장면이다. 폰과
    // 콘솔만 붙였더니 "그 번호가 어디로 들어갔는가"가 빠져 아무 말도 하지
    // 않는 그림이 됐다.
    out: 's1-join',
    from: '장면 1 — 상점을 찾는다',
    to: '장면 2 — 자리가 찬다',
    /*
      **원본보다 크게 잡지 않는다.** 폰 390×844, 태블릿 1280×720, 콘솔
      1440×900이 그대로 들어갈 상자를 쓴다. 키우면 화질만 잃고, `scale`이
      비율을 지키느라 상자보다 1px 커지는 순간 `pad`이 죽는다.

      위가 손(폰)과 자리(태블릿), 아래가 상점(콘솔)이다. 번호가 위에서
      아래로 이동하는 순서와 화면 배치가 같다.
    */
    rows: [
      [tile('phone', 390, 844), tile('seat-hero', 1280, 844)],
      [tile('console', 1670, 900)],
    ],
    fps: 6,
    width: 1000,
  },
  {
    out: 's2-hand',
    from: '장면 2 — 대회가 열린다',
    to: '장면 3 — 올인',
    rows: [
      [tile('seat-hero', 960, 540), tile('seat-p2', 960, 540)],
      [tile('dealer', 960, 540), tile('scoreboard', 960, 540)],
    ],
    fps: 8,
    width: 1280,
  },
  {
    /*
      **올인부터 탈락까지가 한 장면이다.** 나눠 놓으니 사이드팟 정산과 그
      결과(미드스택이 0이 되어 자리에서 빠지는 것)가 서로 다른 그림이 됐는데,
      실제로는 배분 한 번이 그 둘을 동시에 만든다.

      면 넷은 딜러와 좌석 셋이다. 미드스택 타일이 리바인 오버레이 → 탈락 →
      대기 화면으로 바뀌는 것이 **소켓으로 온 변화**이고, 등수는 움짤이
      아니라 스틸(`phone-eliminated.png`)이 맡는다 — 폰은 이 순간 아무도
      건드리지 않는 화면이라 타일을 하나 쓸 값어치가 없다.
    */
    out: 's3-sidepot',
    from: '장면 3 — 올인',
    to: '장면 5 — 2번 테이블을 통째로 비운다',
    // 상자에 2px 여유를 준다. 1280×720을 880×495로 줄이면 계산상 딱 맞지만
    // `scale`의 반올림이 위로 튀는 순간 `pad`이 "입력보다 작다"로 죽는다.
    rows: [
      [tile('dealer', 882, 497), tile('seat-hero', 882, 497)],
      [tile('seat-p1', 882, 497), tile('seat-p2', 882, 497)],
    ],
    fps: 8,
    width: 1200,
  },
  {
    /*
      **자리가 바뀌는 것은 A인데, 그 사실이 네 화면에 각각 다르게 나타난다.**
      위가 A의 태블릿(자리에서 나와 1번 테이블로 간다)과 B의 태블릿(가만히
      있는데 옆자리가 찬다), 아래가 콘솔(자리를 푸는 손)과 A의 폰(다시 넣을
      참가 OTP)이다.
    */
    out: 's5-table-merge',
    from: '장면 5 — 2번 테이블을 통째로 비운다',
    to: '끝',
    /*
      **열을 위아래로 맞춘다.** 콘솔과 폰을 1360:400으로 두었더니 아래 행의
      경계가 위 행과 어긋나 한 화면처럼 읽혔다. 콘솔을 위 태블릿과 같은 폭
      (880)으로 두고, 폰은 남은 880 안에서 제 비율대로 레터박스를 갖는다 —
      손 안의 화면이 태블릿만 한 폭을 차지할 이유도 없다.
    */
    rows: [
      [tile('seat-mover', 880, 500), tile('seat-p2', 880, 500)],
      [tile('console', 880, 560), tile('phone', 880, 560)],
    ],
    fps: 8,
    width: 1280,
  },
];

function tile(label, width, height) {
  return { label, width, height };
}

function ffmpeg(args) {
  execFileSync(/** @type {string} */ (ffmpegPath), ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function mib(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(2);
}

function loadTimeline() {
  const dir = join(RECORDINGS, TAKE);
  const path = join(dir, 'timeline.json');
  if (!existsSync(path)) {
    throw new Error(
      [
        `촬영 기록이 없다: ${path}`,
        '',
        '  npm run demo      (시드 → 촬영)',
        '',
        '촬영 폴더 이름은 테스트 제목에서 나온다. 제목을 바꿨으면 이 파일의',
        'TAKE 상수도 같이 고친다.',
      ].join('\n'),
    );
  }
  return { dir, timeline: JSON.parse(readFileSync(path, 'utf8')) };
}

function markAt(timeline, name) {
  const found = timeline.marks.find((m) => m.name === name);
  if (!found) {
    const had = timeline.marks.map((m) => m.name).join('\n  ');
    throw new Error(`장면 표시 "${name}"이 촬영 기록에 없다. 있는 것:\n  ${had}`);
  }
  return found.offsetMs / 1000;
}

/**
 * 슬레이트가 나타나는 지점(초). 자홍색은 V(적색차) 성분이 극단으로 튀므로
 * `signalstats`의 `VAVG`가 가장 큰 프레임을 고른다.
 *
 * 앞 20초만 본다 — 슬레이트는 면을 연 직후이고, 뒤까지 뒤지면 화면의 붉은
 * 요소(거절 배너 같은 것)와 겨루게 된다.
 */
function probeSlate(file) {
  const out = spawnSync(
    /** @type {string} */(ffmpegPath),
    [
      '-hide_banner', '-loglevel', 'error',
      '-t', '20', '-i', file,
      // `file=-`가 아니면 `metadata=print`는 info 로그로 나가고, 우리가 켠
      // `-loglevel error`에 통째로 잘린다.
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.VAVG:file=-',
      '-f', 'null', '-',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const lines = text.split('\n');
  let bestAt = null;
  let best = -Infinity;
  let pts = null;
  for (const line of lines) {
    const t = line.match(/pts_time:([0-9.]+)/);
    if (t) {
      pts = Number(t[1]);
      continue;
    }
    const v = line.match(/VAVG=([0-9.]+)/);
    if (v && pts !== null) {
      const value = Number(v[1]);
      if (value > best) {
        best = value;
        bestAt = pts;
      }
    }
  }
  // 자홍색의 V는 200을 훌쩍 넘는다. 중립 화면은 128 근처다.
  if (bestAt === null || best < 160) {
    throw new Error(
      `슬레이트를 못 찾았다: ${file} (가장 큰 VAVG ${best.toFixed?.(1) ?? best}). ` +
      '촬영을 다시 돌린다 — 슬레이트 없이 찍은 영상은 다른 면과 맞출 수 없다.',
    );
  }
  return bestAt;
}

function surfaceEntry(timeline, label, file) {
  const found = timeline.surfaces.find((s) => s.label === label);
  if (!found) {
    const had = timeline.surfaces.map((s) => s.label).join(', ');
    throw new Error(`면 "${label}"이 촬영 기록에 없다. 있는 것: ${had}`);
  }
  if (found.slateAtMs === undefined) {
    throw new Error(`면 "${label}"에 슬레이트 시각이 없다. 촬영을 다시 돌린다.`);
  }
  // 영상의 0초에 해당하는 촬영 시각. 슬레이트가 찍힌 프레임이 그 시각이므로
  // 거기서 빼면 된다.
  return { openedAt: found.slateAtMs / 1000 - probeSlate(file) };
}

/**
 * 촬영 시각 하나를 그 면의 영상 시각으로 옮긴다. 0초가 다를 뿐이라 빼기다.
 *
 * 열리기 전은 0으로 눕힌다 — 그 면에는 그 순간에 해당하는 그림이 아예 없고,
 * 부르는 쪽이 그만큼 앞을 검게 채운다.
 */
function toVideoTime(surface, wallSeconds) {
  return Math.max(0, wallSeconds - surface.openedAt);
}

/** 장면 하나를 애니메이션 WebP로 만든다. */
function buildScene(dir, timeline, scene) {
  const start = markAt(timeline, scene.from);
  const end = markAt(timeline, scene.to);
  const inputs = [];
  const filters = [];

  // 행마다 폭이 같아야 `vstack`이 붙는다. 어긋나면 ffmpeg가 실패하는데,
  // 그 메시지로는 어느 장면의 어느 행인지 알 수 없어 여기서 먼저 본다.
  const rowWidths = scene.rows.map((row) => row.reduce((w, t) => w + t.width, 0));
  if (new Set(rowWidths).size > 1) {
    throw new Error(`${scene.out}: 행마다 폭이 다르다 (${rowWidths.join(' · ')}).`);
  }

  let n = 0;
  const rowLabels = [];
  scene.rows.forEach((row, r) => {
    const cells = [];
    for (const t of row) {
      const file = join(dir, `${t.label}.webm`);
      if (!existsSync(file)) throw new Error(`영상이 없다: ${file}`);
      inputs.push('-i', file);

      // 촬영 시각을 이 파일의 시각으로 옮긴다. 면이 그 장면 도중에 열렸으면
      // 앞부분은 검은 화면으로 채운다 — 그 순간의 그림이 아예 없다.
      const surface = surfaceEntry(timeline, t.label, file);
      const from = toVideoTime(surface, start);
      const to = toVideoTime(surface, end);
      const lead = Math.max(0, Math.min(surface.openedAt, end) - start);
      filters.push(
        `[${n}:v]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS,` +
          `tpad=start_duration=${lead.toFixed(3)}:start_mode=add:color=black,` +
          // `scale`이 비율을 지키느라 1px 넘길 때가 있다(폰 390×844를 높이
          // 기준으로 줄이면 반올림으로 상자보다 커진다). 그러면 `pad`이
          // "패딩이 입력보다 작다"로 죽는다. 그래서 넉넉히 채운 뒤 상자
          // 크기로 정확히 잘라낸다 — 잃는 것은 많아야 1px이고, 타일 크기가
          // 정확해야 `hstack`·`vstack`이 붙는다.
          `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          // 작은따옴표 안에서는 쉼표가 그대로 쉼표다. `\\,`로 escape하면
          // 역슬래시까지 식에 들어가 max()가 깨진다.
          `pad=w='max(iw,${t.width})':h='max(ih,${t.height})':x=(ow-iw)/2:y=(oh-ih)/2:color=black,` +
          `crop=${t.width}:${t.height},` +
          // 격자. 타일끼리 맞붙으면 어디까지가 한 화면인지 읽히지 않는다 —
          // 특히 콘솔(흰 바탕)과 폰(흰 바탕)이 나란히 붙으면 한 화면처럼
          // 보인다. 안쪽에 2px 선을 그어 면의 경계를 만든다.
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

  const out = join(ASSETS, `${scene.out}.webp`);
  ffmpeg([
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-c:v',
    'libwebp_anim',
    '-lossless',
    '0',
    // 화질. `-q:v 50`으로 찍었더니 전광판처럼 검은 바탕에 큰 흰 숫자가 있는
    // 면에서 **잔상**이 남았다 — 숫자가 바뀐 자리에 앞 프레임의 획이 흐리게
    // 붙어 있는 것이다. 장면당 2MB 예산에 견줘 결과물이 0.2MB대라 올릴 여유가
    // 충분했다.
    '-q:v',
    '85',
    // libwebp의 프리셋. 화면이 사진이 아니라 **글자와 선**이라 경계를 지키는
    // 쪽을 고른다. 기본값(`default`)은 사진 기준으로 고주파를 뭉갠다.
    '-preset',
    'text',
    '-compression_level',
    '6',
    '-loop',
    '0',
    '-an',
    '-y',
    out,
  ]);

  console.log(
    `  ${scene.out}.webp  ${(end - start).toFixed(1)}초 · 면 ${n} · ${scene.fps}fps · ${mib(out)}MB`,
  );
}

/**
 * README에 붙는 스틸. 촬영이 이 이름으로 떨어뜨린다(`shoot()`).
 *
 * **이름을 여기 적어 두는 이유**: `.shots/`는 gitignore라 지난 세션의 디버그
 * 캡처가 그대로 남아 있다. 폴더째 옮기면 그것들까지 리포에 들어간다.
 */
const STILLS = [
  'console.png', // 화면 1 — 콘솔 대회 상세(좌석 도식)
  'seat-waiting.png', // 화면 2 — 자리 고르기 · OTP 키패드
  'seat-game.png', // 화면 3 — 좌석 펠트(딜러가 위)
  'seat-rebuy.png', // 화면 4 — 리바인 오버레이
  'dealer-felt.png', // 화면 5 — 딜러 펠트(사이드팟 층이 보인다)
  'dealer-winner.png', // 화면 6 — 승자 결정
  'dealer-refused.png', // 화면 6b — 지명되지 않은 팟을 거부한 순간
  'scoreboard.png', // 화면 7 — 전광판
  'phone-me.png', // 화면 8 — 폰의 참가 OTP
  'seat-moved.png', // 장면 5 — 옮겨 앉아도 스택이 그대로다
  'seat-joined.png', // 장면 5 — 가만히 있던 사람의 화면에 옆자리가 찬다
  'console-dealer-otp.png', // 장면 1 — 상점이 딜러 OTP를 꺼낸다
  'dealer-refused-before-start.png', // 장면 2 — 대회 전에는 핸드가 안 열린다
  'phone-eliminated.png', // 장면 4 — 참가 OTP가 아니라 등수가 남는다
];

/**
 * 스틸은 촬영 중에 이미 PNG로 떨어졌다(`e2e/.shots/`). 여기서는 옮기기만
 * 한다 — 영상 프레임을 뽑지 않는 이유는 webm이 손실 압축이라 글자가 뭉개져
 * 나오기 때문이다.
 */
function copyShots() {
  const missing = [];
  for (const name of STILLS) {
    const from = join(SHOTS, name);
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }
    const to = join(ASSETS, name);
    copyFileSync(from, to);
    console.log(`  ${name}  ${mib(to)}MB`);
  }
  if (missing.length > 0) {
    throw new Error(`촬영이 남기지 않은 스틸이 있다: ${missing.join(', ')}`);
  }
}

const { dir, timeline } = loadTimeline();
mkdirSync(ASSETS, { recursive: true });

console.log('움짤');
for (const scene of SCENES) buildScene(dir, timeline, scene);
console.log('스틸');
copyShots();
