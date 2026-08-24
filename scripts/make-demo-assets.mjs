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

/**
 * **바이너리가 있는지 먼저 본다.**
 *
 * `ffmpeg-static`은 postinstall로 실행 파일을 내려받는데, 그것이 막힌 환경에서는
 * 패키지만 남고 `ffmpeg.exe`가 없다. 그러면 `spawnSync`가 조용히 실패하고
 * 출력이 비는데, 슬레이트를 찾는 쪽은 그 빈 출력을 **「이 영상에 슬레이트가
 * 없다」**로 읽어 "촬영을 다시 돌려라"라고 말한다 — 12분짜리 촬영을 다시
 * 돌리게 만드는 오진이라 여기서 먼저 잡는다.
 */
function assertFfmpeg() {
  if (ffmpegPath && existsSync(ffmpegPath)) return;
  throw new Error(
    [
      `ffmpeg 실행 파일이 없다: ${ffmpegPath ?? '(경로 자체가 비었다)'}`,
      '',
      '  node node_modules/ffmpeg-static/install.js',
      '',
      '`ffmpeg-static`은 postinstall로 바이너리를 내려받는다. 그 단계가 막힌',
      '환경에서는 패키지만 설치되고 실행 파일이 없다. 촬영 원본은 멀쩡하다.',
    ].join('\n'),
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RECORDINGS = join(ROOT, 'frontend', 'e2e', 'recordings');
const SHOTS = join(ROOT, 'frontend', 'e2e', '.shots');
const ASSETS = join(ROOT, 'img');

/**
 * 촬영 폴더 이름은 테스트 제목에서 나온다(`surfaces.ts`의 `slug`).
 *
 * **촬영이 둘이다.** 장면 1~5(`demo/tournament.spec.ts`)와 정산
 * (`demo/settlement.spec.ts`)이고, 정산은 마무리마다 따로 돈다 — 하나가
 * 대회를 닫으면 나머지는 찍을 자리가 없어서다. 그래서 폴더도 마무리마다
 * 하나씩 생긴다.
 */
const TAKE = '장면-1-5-한-대회';
const SETTLEMENT_TAKE = {
  complete: '마무리-최후-1인으로-닫는다',
  chop: '마무리-ICM으로-닫는다',
  abort: '마무리-중단하고-환불한다',
};

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
    out: '01-join-phone-to-console',
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
    out: '06-one-click-four-surfaces',
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
      아니라 스틸(`26-phone-shows-rank.png`)이 맡는다 — 폰은 이 순간 아무도
      건드리지 않는 화면이라 타일을 하나 쓸 값어치가 없다.
    */
    out: '02-sidepot-dealer-refused',
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
    out: '14-seat-move-closeup',
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

/**
 * 정산 촬영의 장면 셋.
 *
 * **이름이 그 장면의 주장이다.** `s6`·`s7` 같은 번호만으로는 `img/`를 열어
 * 봐도 무엇을 보여주는 그림인지 알 수 없고, README가 그림을 고를 때마다
 * 영상을 다시 열어야 한다.
 *
 * 마무리 장면만 마무리마다 이름이 다르다 — **셋이 같은 자리에서 갈리므로
 * 파일 이름이 유일한 구분**이고, 셋을 나란히 놓는 것이 이 촬영의 요점이다.
 *
 * `마감 대기`와 `마감` 사이는 어느 장면에도 안 들어간다. 등록 마감을
 * 기다리는 몇 분이라 버릴 구간이고, 표시를 둘로 나눈 이유가 그것이다.
 */
const SETTLEMENT_CLOSE = {
  complete: 's9-close-last-one',
  chop: 's9-close-icm',
  abort: 's9-close-abort',
};

function settlementScenes(ending) {
  return [
    {
      /*
        **한 판에 여섯이 올인해 다섯이 나간다.** 필드가 줄어드는 방식 자체가
        이 촬영의 전제라 첫 판을 통째로 보여준다 — 진짜 올인이고 진짜 지명이다.

        태블릿 둘을 나란히 두는 이유: 같은 판에서 하나는 폴드해 살아남고
        하나는 올인해 나간다.
      */
      out: 's6-six-all-in',
      from: '첫 판 — 한 판에 여섯이 올인한다',
      to: '리바인 — 엔트리가 늘면 상금권도 는다',
      rows: [
        [tile('seat-rebuyer', 960, 540), tile('seat-survivor', 960, 540)],
        [tile('dealer-final-table', 960, 540), tile('scoreboard', 960, 540)],
      ],
      fps: 8,
      width: 1280,
    },
    {
      /*
        **엔트리와 사람 수가 갈리는 순간.** 탈락자 하나가 리바인을 수락하면
        전광판의 엔트리만 36이 되고 상금 목록이 다섯 줄에서 여섯 줄로 는다 —
        참가는 35명 그대로다.

        면이 둘뿐인 이유: 주장이 「이 수락이 저 목록을 바꾼다」 하나라, 셋째
        면은 그 인과를 흐린다.
      */
      out: 's7-entry-not-player',
      from: '리바인 — 엔트리가 늘면 상금권도 는다',
      to: '마감 대기 — 여기부터 버린다',
      rows: [[tile('seat-rebuyer', 960, 540), tile('scoreboard', 960, 540)]],
      fps: 5,
      width: 1100,
    },
    {
      /*
        **테이블 넷이 하나가 된다.** 콘솔의 좌석 도식이 그 사실을 드러내는
        유일한 화면이라 아래 행을 통째로 준다 — 사람이 칩을 들고 걸어가는
        일이라 자동이 아니고, 상점이 좌석을 풀고 테이블을 닫는 손이 거기 있다.

        콘솔을 1440×900 그대로 둔다. **원본보다 크게 잡지 않는다** — 키우면
        화질만 잃고, `scale`이 비율을 지키느라 상자보다 커지는 순간 `pad`이
        「입력보다 작다」로 죽는다. 실제로 1760×1100으로 잡았다가 그렇게 실패했다.

        **여유는 높이에만 준다.** 폭은 `vstack`이 행끼리 맞추라고 요구하므로
        건드릴 수 없고, `scale`의 반올림이 튀는 것은 어느 축에서든 일어난다.
        높이 몇 px을 더 주면 `pad`이 언제나 입력보다 크다.
      */
      out: 's8-four-tables-to-one',
      from: '마감 — 상금이 예상에서 확정으로 바뀐다',
      to: '여섯째 — 상금이 처음 나간다',
      rows: [
        [tile('dealer-final-table', 720, 410), tile('seat-survivor', 720, 410)],
        [tile('console', 1440, 906)],
      ],
      fps: 6,
      width: 1100,
    },
    {
      /*
        **마무리.** 콘솔이 주인공이라 위 행을 통째로 준다 — 셋이 한 화면에
        있고, 못 누르는 것은 왜 못 누르는지가 그 자리에 적혀 있고, 확인
        대화의 마지막 줄이 걷은 돈이다.
      */
      out: SETTLEMENT_CLOSE[ending],
      from: '여섯째 — 상금이 처음 나간다',
      to: '끝',
      rows: [
        [tile('console', 1440, 906)],
        [tile('dealer-final-table', 720, 410), tile('scoreboard', 720, 410)],
      ],
      fps: 6,
      width: 1100,
    },
  ];
}

function tile(label, width, height) {
  return { label, width, height };
}

/**
 * **실패하면 ffmpeg가 한 말을 남긴다.**
 *
 * `stdio: 'inherit'`로 흘려보내면 `execFileSync`가 던지는 예외의 `stderr`가
 * `null`이라, 남는 것이 "status 4294967274"와 300줄짜리 필터 문자열뿐이다.
 * 어느 필터가 무엇을 거부했는지가 그 안에 없어서 장면 하나를 고칠 때마다
 * 손으로 명령을 다시 조립해야 했다. 필터 그래프가 틀리는 것은 흔한 일이라
 * (행마다 폭이 다르다, 상자가 원본보다 크다) 여기가 첫 안내여야 한다.
 */
function ffmpeg(args) {
  const run = spawnSync(
    /** @type {string} */ (ffmpegPath),
    ['-hide_banner', '-loglevel', 'error', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status === 0) return;
  const said = `${run.stderr ?? ''}`.trim();
  throw new Error(
    [
      `ffmpeg가 실패했다 (status ${run.status}).`,
      said ? `\n${said}` : '\n(ffmpeg가 아무 말도 남기지 않았다)',
    ].join(''),
  );
}

function mib(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(2);
}

function loadTimeline(take) {
  const dir = join(RECORDINGS, take);
  const path = join(dir, 'timeline.json');
  if (!existsSync(path)) {
    throw new Error(
      [
        `촬영 기록이 없다: ${path}`,
        '',
        '  npm run demo              (시드 → 장면 1~5 촬영)',
        '  npm run demo:settlement   (마무리 셋을 각각 시드부터 다시)',
        '',
        '촬영 폴더 이름은 테스트 제목에서 나온다. 제목을 바꿨으면 이 파일의',
        'TAKE · SETTLEMENT_TAKE 상수도 같이 고친다.',
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

/**
 * 스틸은 촬영 중에 이미 PNG로 떨어졌다(`e2e/.shots/`). 여기서는 옮기기만
 * 한다 — 영상 프레임을 뽑지 않는 이유는 webm이 손실 압축이라 글자가 뭉개져
 * 나오기 때문이다.
 */
/**
 * 정산 촬영의 스틸. **이름이 그 사진의 주장이다.**
 *
 * 마무리 장부 둘(`19-chop-ledger-sums` · `21-abort-ledger-groups`)은 그
 * 마무리를 실제로 돌린 촬영에만 있다. 확인 대화가 그때만 열리기 때문이고,
 * 없는 것을 요구하면 다른 마무리 촬영이 통째로 실패한다.
 */
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

function copyShots(stills) {
  const missing = [];
  for (const name of stills) {
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

/**
 * 어느 촬영을 자를지. 기본값은 장면 1~5다 — `npm run assets`가 그대로 돈다.
 *
 * `--settlement=chop` 처럼 마무리를 골라 정산 촬영을 자른다. 셋을 한 번에
 * 자르지 않는 이유는 **촬영이 셋이기 때문**이다. 하나가 대회를 닫으므로
 * 마무리마다 시드를 다시 깔고 다시 찍고, 그때마다 이 스크립트를 부른다.
 */
const settlementArg = process.argv
  .find((a) => a.startsWith('--settlement='))
  ?.slice('--settlement='.length);

if (settlementArg && !(settlementArg in SETTLEMENT_TAKE)) {
  const had = Object.keys(SETTLEMENT_TAKE).join(' · ');
  throw new Error(`--settlement은 ${had} 중 하나다. 받은 것: ${settlementArg}`);
}

const take = settlementArg ? SETTLEMENT_TAKE[settlementArg] : TAKE;
const scenes = settlementArg ? settlementScenes(settlementArg) : SCENES;
const stills = settlementArg ? settlementStills(settlementArg) : STILLS;

assertFfmpeg();
const { dir, timeline } = loadTimeline(take);
mkdirSync(ASSETS, { recursive: true });

console.log('움짤');
for (const scene of scenes) buildScene(dir, timeline, scene);
console.log('스틸');
copyShots(stills);
