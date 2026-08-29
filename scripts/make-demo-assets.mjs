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
/**
 * 슬레이트가 화면을 덮는 시간. `surfaces.ts`가 자홍색을 400ms 띄운다.
 *
 * 여기서 넉넉히 잡는 이유는 **경계를 밟지 않기 위해서**다. 자르는 쪽이
 * 슬레이트 직후부터 붙이는데, 딱 400ms로 자르면 사라지는 프레임과 첫
 * 그림 프레임 사이에 한 장이 낀다. 그 한 장이 곧 자홍색이다.
 */
const SLATE_SECONDS = 0.6;

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
    caption: '폰에서 받은 번호를 자리 태블릿에 넣으면 콘솔에 뜬다',
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
    caption: '대회를 열어야 딜러가 핸드를 시작할 수 있다',
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
    caption: '팟이 둘로 갈린다. 사이드팟을 빠뜨리면 지급이 거부된다',
    from: '장면 3 — 올인',
    to: '장면 5 — 2번 테이블을 통째로 비운다',
    // 상자에 여유를 준다. 1280×720을 880×495로 줄이면 계산상 딱 맞지만
    // `scale`의 반올림이 위로 튀는 순간 `pad`이 "입력보다 작다"로 죽는다.
    // 높이는 **짝수**여야 한다(`assertEvenTiles`) — 497로 두면 그 검사에
    // 걸린다.
    rows: [
      [tile('dealer', 882, 498), tile('seat-hero', 882, 498)],
      [tile('seat-p1', 882, 498), tile('seat-p2', 882, 498)],
    ],
    fps: 8,
    width: 1200,
  },
  /*
    `14-seat-move-closeup`이 여기 있었다. 장면 5의 좌석 이동을 네 면으로
    담은 것인데, **정산의 `03-four-tables-to-one`이 같은 것을 더 크게
    말한다** — 이쪽은 두 테이블이 하나가 되고 폰이 하나라 「이 사람이
    옮겼다」로 읽히지만, 저쪽은 네 테이블이 둘이 되고 폰이 둘이라
    「필드가 줄어드는 중이다」가 된다.

    잃는 것이 없다. 이 장면의 스틸 `15-stack-survives-move.png`는 촬영이
    계속 남기고, README에서 이 움짤이 있던 자리는 `03`이 받는다 — 그
    자막이 이미 그 절의 제목과 같은 문장이다.
  */
];

/**
 * 정산 촬영이 내놓는 움짤 넷.
 *
 * **실행마다 다시 만들지 않는다.** 갈림목 전까지 세 실행이 똑같으므로
 * 프레임 ①·②는 `complete` 하나에서만 자른다 — 전에는 마무리마다 같은 그림을
 * 셋씩 만들고 이름만 달랐다.
 *
 * 배치의 근거는 설계 문서에 있다
 * (`docs/superpowers/specs/2026-08-24-settlement-demo-design.md`).
 */
function settlementScenes() {
  return [
    {
      /*
        **엔트리는 사람 수가 아니다.**

        네 테이블에서 한꺼번에 올인하고 딜러가 지명하면 스물이 사라진다.
        전광판의 남은 인원이 그 자리에서 35에서 15로 떨어진다. 이어서 T3의
        한 자리가 0에서 5,000으로 되살아나고 **엔트리만** 36이 된다 — 사람은
        15 그대로다.

        원인(딜러 타일의 스택 부활)과 결과(전광판)가 한 프레임에 있어야
        인과가 읽힌다. 그래서 리바인하는 사람이 T3에 있다.

        **넷이 같은 순간에 돈다.** 전에는 rebuyer의 테이블(T3)만 맨 뒤로
        돌렸고, 그래서 이 4분할에서 T3만 앞 절반을 멈춰 있었다 — 「한꺼번에」가
        화면에서 반만 성립했다. 늦게 돌린 이유는 리바인 창 15초였는데, 그
        창을 쓰는 것은 오히려 남이 도는 시간이라 동시에 도는 편이 덜 쓴다
        (`settlement.spec.ts`의 첫 판 블록).

        T4가 아니라 T1을 넣는다. T1이 촬영 테이블이자 병합의 종착지라 여기서
        본 펠트가 프레임 ②·③에 계속 나온다 — T1을 빼면 이 프레임에서 본
        테이블 중 어느 것도 뒤에 안 나온다.
      */
      out: '11-entry-not-player',
      caption: '남은 인원은 줄고, 리바인하면 엔트리가 오른다',
      take: 'complete',
      from: '첫 판 — 한 판에 스물이 나간다',
      /*
        **`병합` 마크까지 가지 않는다.** 이 프레임의 이야기는 리바인을 누르고
        전광판이 36으로 오르는 데서 끝나는데, 그 마크는 상점이 콘솔을 다시
        읽고 다음 장면을 준비하는 자리까지 가 있다 — 31초 중 마지막 10초가
        **아무도 아무것도 안 하는 그림**이었다.

        `리바인` 마크에서 8초를 센다. 그 사이에 수락이 반영되고(전광판 엔트리
        35 → 36, 상금 목록 다섯 줄 → 여섯 줄) 딜러 타일의 스택이 되살아난다.
      */
      to: { at: '리바인 — 엔트리가 늘면 상금권도 는다', plus: 8 },
      /*
        **원인이 조작으로, 결과가 전광판으로.**

        아래 왼쪽이 `dealer-t3`였다. T3 펠트에서 한 자리가 0에서 5,000으로
        되살아나는 것을 보여주려던 자리인데, 그 부활은 **결과**이고 원인인
        「사람이 리바인을 누른다」는 어디에도 없었다. 리바인을 묻는 팝업은
        그 사람의 좌석 태블릿에만 뜨므로(`sendToTableUser`) 딜러 화면에는
        스택이 저절로 바뀌는 그림만 남는다.

        그래서 그 자리를 **누르는 손**으로 바꾼다. 부활한 스택은 전광판의
        엔트리 36이 대신 든다 — 이 프레임이 애초에 주장하는 숫자가 그것이다.

        위 둘은 딜러가 승자를 찍는 모달이 **둘 다** 뜬다(`MODAL_TABLE`).
      */
      rows: [
        [tile('dealer-t1', 880, 496), tile('dealer-t2', 880, 496)],
        [tile('seat-rebuyer', 880, 496), tile('scoreboard', 880, 496)],
      ],
      /*
        **5fps는 이 프레임이 108초였을 때의 값이다.** 첫 판에서 딜러가 등수를
        올인한 인원 수만큼 찍던 시절이고, 8fps면 870프레임에 5MB가 넘어
        README가 무거워졌다.

        지금은 36초다 — 층이 하나인 판은 1등 한 명만 찍는다. 그리고 이
        프레임이 보여줄 것 중 **가장 빠른 것이 그 조작**이라, 자리를 누르고
        「배분」을 누르는 2초를 열 프레임으로 그리면 커서가 뚝뚝 끊긴다.
        「딜러가 지명하니 사람이 사라진다」가 이 그림의 인과인데 그 손이
        안 읽힌다.
      */
      fps: 8,
      width: 1000,
      quality: 72,
    },
    {
      /*
        **필드가 넷에서 하나로. 자동이 아니라 사람이 걸어간다.**

        상점이 좌석을 풀고, 사람이 폰에서 참가 OTP를 다시 보고, 그 번호를 새
        자리 태블릿에 넣는다. 셋이 각각 다른 손의 일이고, 온라인이면 서버가
        재배치하고 끝날 것이 여기서는 세 조작이 된다.

        **둘이 서로 다른 테이블로 흩어진다**(T3→T1, T4→T2). 폰이 둘인 것이
        거기서 값을 한다 — 하나면 「이 사람이 옮겼다」이고, 둘이면 「테이블이
        합쳐지는 중이다」가 된다.

        칩은 좌석보다 오래 산다. 옮겨 앉아도 스택이 그대로인 것이 좌석 타일에
        남는다.
      */
      out: '03-four-tables-to-one',
      caption: '테이블을 합치는 것은 사람이 걸어가는 일이다',
      take: 'complete',
      from: '병합 — 네 테이블이 둘이 된다',
      to: '둘째 판 — 두 테이블에서 열이 나간다',
      rows: [
        [tile('seat-rebuyer', 880, 496), tile('seat-mover', 880, 496)],
        [
          tile('console', 1180, 738),
          tile('phone-rebuyer', 290, 738),
          tile('phone-mover', 290, 738),
        ],
      ],
      fps: 8,
      width: 1100,
    },
    {
      /*
        **두 문, 같은 등식. 이 프레임만 실행을 가로지른다.**

        좌열이 `chop`, 우열이 `complete`다. 같은 시드라 파이널 테이블에 남는
        셋이 두 실행에서 같고, 그래서 좌우가 **같은 사람의 다른 결말**이 된다.
        그 동일성은 우연이 아니라 `settlement.spec.ts`의 `FIRST_HAND_ALL_IN`이
        지킨다 — 첫 버튼이 무작위라 승자 스택이 300 흔들리는데, 첫 판 인원을
        테이블마다 벌려 그 흔들림이 승자를 못 뒤집게 했다.

        위아래가 다른 것을 말한다.

        - **위** — 왼쪽은 콘솔에서 합의한 숫자를 적고, 오른쪽은 테이블에서
          끝까지 쳐서 정한다. **딜은 콘솔의 일이고 승부는 펠트의 일이다.**
          `complete`에는 확인 대화가 없다 — 「종료」가 `completeTournament`를
          바로 부른다
        - **아래** — 왼쪽 폰 셋은 칩 비율이 정한 금액, 오른쪽 폰 셋은 분배표가
          정한 1·2·3위 금액. **같은 화면에 다른 숫자**다

        전광판은 여기 없다. 넣으면 좌우 대칭이 깨지고, 「제도가 정한 표」는
        README에서 이 움짤 바로 위에 스틸로 놓는다
        (`04-prize-table-locked.png`).

        설계의 880×550 · 293×634를 882×550 · 294×634로 올렸다. 폰 여섯의
        폭이 짝수여야 하는데(`assertEvenTiles`) 293은 홀수고, 294×6은
        1764라 위 행도 882×2로 맞춘 것이다. 잃는 것은 2px이다.
      */
      out: '05-two-doors-same-ledger',
      /*
        **좌우가 아니라 앞뒤다.**

        처음에는 좌우로 놓았다. 그런데 나란히 놓는 것은 「이 둘에 공통 시계가
        있다」는 주장이고, 두 실행에는 그런 것이 없다 — `chop`은 확인 대화를
        닫으면 바로 정산이고 `complete`는 문을 누른 뒤 **최후의 판을 실제로
        쳐야** 끝난다. 그래서 짧은 쪽이 `tpad`의 정지 화면으로 긴 쪽을
        기다렸다(12.2초 → 창을 옮겨 3.3초 → 실행이 흔들리자 3.0초가 반대쪽에).

        **창을 어떻게 잡아도 길이는 실행마다 달라진다.** 고칠 자리는 창이
        아니라 배치였다.

        대조는 진행이 아니라 **끝 상태**에서 선다. 폰 여섯이 각각 무엇을
        받았는가 — `548,568 / 408,348 / 274,284` 대 `615,600 / 372,600 /
        243,000` — 가 이 프레임의 주장이고, 그것을 보려고 두 실행의 중간을
        동시에 굴릴 필요가 없다. 순서대로 보여주고 조각마다 무엇인지 적는다.

        `chop`은 `마무리 — 셋이 한 화면에 있다`부터 연다. ICM 모달을 열기
        전에 **마무리 카드 셋**(종료 · ICM · 중단)이 먼저 나오고, 그중 하나를
        누르는 그림이 된다 — 「문이 셋인데 이 실행은 이 문으로 갔다」가 조각
        안에 들어간다. `complete`는 그 카드가 이미 지나갔으므로 문을 누르는
        자리부터다.
      */
      parts: [
        {
          take: 'chop',
          from: '마무리 — 셋이 한 화면에 있다',
          /*
            **프레임 ④와 같은 이유로 `끝`까지 가지 않는다.** 콘솔은 정산이
            확정되는 순간 할 일이 끝나는데(폴링이 없다) `끝` 마크는 참가자
            폰 셋이 갱신되기를 기다린 뒤에 찍힌다. 그래서 20.8초 중 7초가
            **같은 그림**이었다.

            잘라도 잃는 것이 없다. 이 조각이 마지막에 주장하는 「걷은 돈이
            상금과 상점 몫으로 다 나갔다」는 정지가 시작되기 전에 이미 떠
            있고, 그 화면은 `23-closed-chop.png`가 스틸로 따로 든다.
          */
          to: { at: '끝', plus: -4 },
          caption: '① 합의로 끝낸다 — 상금은 남은 칩만큼 나눈다',
          rows: [
            [
              tile('console', 1180, 738),
              tile('phone-final-1', 290, 738),
              tile('phone-final-2', 290, 738),
              tile('phone-final-3', 290, 738),
            ],
          ],
        },
        {
          take: 'complete',
          from: '마무리 — 그 문을 누른다',
          to: '끝',
          caption: '② 승자를 지정해 끝낸다 — 상금은 상점이 짜 둔 표대로 나눈다',
          rows: [
            [
              tile('dealer-t1', 1180, 738),
              tile('phone-final-1', 290, 738),
              tile('phone-final-2', 290, 738),
              tile('phone-final-3', 290, 738),
            ],
          ],
        },
      ],
      fps: 6,
      // **콘솔이 읽혀야 이 프레임이 성립한다.** 주장이 「두 장부의 걷은 돈이
      // 같다」인데 1100폭에서는 콘솔 타일이 실질 550px이라 숫자가 뭉갠다.
      width: 1500,
    },
    {
      /*
        **중단하면 상점 몫이 0이 된다.**

        프레임 ③에 자리가 없어 따로 남긴다 — 문이 셋인데 좌우가 둘이다.
        그래도 값이 있다: 상점 몫이 0이 되는 유일한 문이라 등식의 오른쪽 항
        셋(상금 · 환불 · 상점 몫)이 한 화면에 다 나오고, 환불이 사람마다가
        아니라 **무리로** 접히는 것이 확인 대화의 표에 그대로 있다.

        **전광판을 뺐다.** 설계는 가로 둘이었는데, 대회가 닫히는 순간
        전광판이 「대기 중」 검은 화면으로 돌아간다 — 20초 창에서 앞 5초만
        말을 하고 나머지 15초는 프레임의 절반이 죽는다. 그 자리를 콘솔에
        주면 확인 대화의 환불 표가 또렷해지고, 닫힌 뒤의 「상점 몫 0」도
        같은 타일에서 읽힌다.
      */
      out: '20-abort-refunds-all',
      caption: '중단하면 낸 돈을 전부 돌려준다. 상점 몫도 0이다',
      take: 'abort',
      from: '마무리 — 그 문을 누른다',
      /*
        **`끝`까지 가지 않는다.** 그 마크는 참가자 폰 셋이 갱신되기를 기다린
        뒤에 찍히는데, 콘솔은 대회가 닫히는 순간 할 일이 끝난다(폴링이 없다).
        그래서 창을 거기까지 열면 20초 중 6.3초가 **같은 그림**이었다 —
        움짤의 3분의 1이다.

        잘라도 잃는 것이 없다. 이 프레임이 마지막에 주장하는 「상점 몫 0」은
        정지가 시작되기 전에 이미 떠 있고, 그 화면은 `24-closed-abort.png`가
        스틸로 따로 든다.
      */
      to: { at: '끝', plus: -8 },
      rows: [[tile('console', 1440, 900)]],
      fps: 6,
      width: 1200,
    },
  ];
}

/**
 * 타일 하나. **`take`를 주면 다른 촬영 실행에서 가져온다.**
 *
 * 마무리 프레임이 `chop`과 `complete`를 좌우로 놓는다. 같은 시드에서 돌아
 * 갈림목 전까지 숫자가 같고 파이널 테이블에 남는 셋도 같다 — 그래서 좌우가
 * **같은 사람의 다른 결말**이 된다. 그 그림을 만들려면 타일마다 다른 폴더와
 * 다른 `timeline.json`을 봐야 한다.
 *
 * 안 주면 그 장면이 정한 기본 실행(`scene.take`)이다. 프레임 하나가 한
 * 실행에서 나오는 것이 여전히 보통이다.
 */
function tile(label, width, height, take) {
  return { label, width, height, take };
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

/**
 * **타일 크기는 짝수여야 한다.** yuv420p의 색차가 가로세로 절반이라
 * 홀수 크기를 담을 수 없다.
 *
 * `pad`은 그 정렬 때문에 홀수 입력을 한 칸 큰 것으로 보고, 상자가 딱 그
 * 홀수면 「출력이 입력보다 작다」로 죽는다. 실제로 880×495 타일 넷이
 * 그렇게 죽었다 — `scale`이 정확히 880×495를 내놓았는데도다.
 *
 * ffmpeg가 남기는 것은 `Parsed_pad_4` 같은 **필터 번호**뿐이라, 그 번호에서
 * 어느 장면의 어느 타일인지 되짚어야 한다. 그래서 여기서 먼저 잡는다.
 *
 * 짝수라도 상자가 원본 비율과 정확히 같으면 `scale` 결과가 상자와 같아지는데,
 * 그때는 `pad`이 그대로 통과한다 — 문제는 **홀수**이지 같은 크기가 아니다.
 */
function assertEvenTiles(scene) {
  const odd = scene.rows
    .flat()
    .filter((t) => t.width % 2 || t.height % 2)
    .map((t) => `${t.label} ${t.width}×${t.height}`);
  if (odd.length === 0) return;
  throw new Error(
    `${scene.out}: 타일 크기가 홀수다 (${odd.join(' · ')}). ` +
      'yuv420p는 짝수만 담는다 — 한 칸 올린다.',
  );
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
 * 창의 경계 하나를 초로 옮긴다.
 *
 * 이름만 주면 그 마크의 시각이고, `{ at, plus }`를 주면 거기서 몇 초 밀거나
 * 당긴 자리다. **마크가 없는 자리를 집어야 할 때가 있다** — 프레임 ③이
 * 실행 둘을 좌우로 놓는데 두 실행의 마무리 구간 길이가 같을 이유가 없고,
 * 그 차이는 마크 사이 어딘가에서 생긴다.
 */
function boundAt(timeline, bound) {
  if (typeof bound === 'string') return markAt(timeline, bound);
  return markAt(timeline, bound.at) + (bound.plus ?? 0);
}

/**
 * 이 실행에서 잘라 낼 구간들. **하나가 아니라 목록이다.**
 *
 * 창을 하나만 낼 수 있으면 「가운데의 죽은 구간」을 버릴 방법이 없고, 실행이
 * 둘인 프레임에서 한쪽 창만 넓힐 방법도 없다. 그래서 장면이 `windows`로
 * 구간 목록을 주고, `windowsByTake`로 실행마다 다른 목록을 줄 수 있다.
 *
 * **도려내기는 그 실행의 모든 타일에서 같은 구간이어야 한다.** 한 타일만
 * 잘라 내면 그 타일의 시계가 옆 타일보다 앞서 가고, 프레임 하나가 서로 다른
 * 순간을 보여주게 된다. 그래서 목록이 타일이 아니라 **실행**에 붙는다.
 *
 * 실행이 다르면(프레임 ③의 좌우) 시계가 애초에 따로라 각자 잘라도 된다 —
 * 맞춰야 하는 것은 **합계 길이** 하나뿐이다.
 */
function segmentsOf(scene, takeName, timeline) {
  const windows =
    scene.windowsByTake?.[takeName] ?? scene.windows ?? [[scene.from, scene.to]];
  const segments = windows.map(([from, to]) => {
    const start = boundAt(timeline, from);
    const end = boundAt(timeline, to);
    if (!(end > start)) {
      throw new Error(
        `${scene.out}: "${takeName}"의 구간이 거꾸로다 (${start.toFixed(3)} → ${end.toFixed(3)}).`,
      );
    }
    return { start, end };
  });
  // 구간이 겹치거나 순서가 뒤바뀌면 같은 순간이 두 번 나오거나 시간이
  // 거꾸로 흐른다. `concat`은 그것을 잡아 주지 않는다.
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].start < segments[i - 1].end) {
      throw new Error(`${scene.out}: "${takeName}"의 구간 ${i + 1}이 앞 구간과 겹친다.`);
    }
  }
  return segments;
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
  const slateAt = probeSlate(file);
  return {
    openedAt: found.slateAtMs / 1000 - slateAt,
    // **슬레이트가 끝나는 지점.** 이 앞은 그림이 아니라 자홍색 마커다.
    //
    // 면이 장면 도중에 열리면 부르는 쪽이 앞을 검게 채우는데(`lead`), 그
    // 바로 뒤에 붙는 것이 영상 0초 — 곧 **슬레이트 자체**다. 프레임 ②의
    // 폰 둘이 그렇게 자홍색 한두 프레임을 결과물에 남겼다.
    //
    // 슬레이트는 자르는 쪽이 시각을 맞추려고 쓰는 마커지 그림이 아니다.
    // 결과물에 새면 그건 촬영이 아니라 **여기의 버그**다.
    firstFrameAt: slateAt + SLATE_SECONDS,
  };
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

/**
 * 이 장면이 **시간축으로** 이어 붙일 조각들. 안 주면 장면 자체가 조각 하나다.
 *
 * `rows`는 공간이고 `parts`는 시간이다. 나란히 놓는 것(`hstack`)은 두 타일에
 * **공통 시계가 있다**는 주장이라, 시계가 없는 것을 나란히 놓으면 짧은 쪽이
 * 긴 쪽을 기다린다 — `tpad`의 정지 화면이 그 기다림이다.
 *
 * 프레임 ③이 그것이었다. `chop`은 확인 대화를 닫으면 바로 정산이고
 * `complete`는 문을 누른 뒤 **최후의 판을 실제로 쳐야** 끝난다. 두 실행은
 * 서로를 기다릴 이유가 없는데 좌우로 붙어 있어서 매번 한쪽이 정지했다
 * (12.2초 → 창을 옮겨 3.3초 → 실행이 흔들리자 다시). **창을 어떻게 잡아도
 * 길이는 실행마다 달라지므로 정지는 다시 생긴다** — 고칠 자리는 배치였다.
 *
 * 대조는 진행이 아니라 **끝 상태**에서 선다(폰 여섯의 금액). 그래서 순서대로
 * 보여주고 각 조각에 무엇인지 적는다.
 */
function partsOf(scene) {
  return (scene.parts ?? [scene]).map((part) => ({
    out: scene.out,
    take: part.take ?? scene.take,
    from: part.from ?? scene.from,
    to: part.to ?? scene.to,
    windows: part.windows ?? scene.windows,
    windowsByTake: part.windowsByTake ?? scene.windowsByTake,
    rows: part.rows ?? scene.rows,
    // 조각이 여럿이면 조각마다 다른 말을 하지만(프레임 ③의 「① 딜」·「② 승부」),
    // 하나뿐인 장면은 장면이 곧 조각이라 위에서 물려받는다.
    caption: part.caption ?? scene.caption,
  }));
}

/**
 * 자막 띠의 높이(px). 그림 **위에** 얹지 않고 위로 덧붙인다 — 화면을 가리면
 * 그 순간의 숫자를 못 읽는데, 이 그림들의 주장이 전부 숫자다.
 */
const CAPTION_BAND = 56;

/** 자막 글자 크기(px). **결과물에서의** 크기다 — 아래에서 축소율만큼 키운다. */
const CAPTION_SIZE = 30;

/**
 * 재생 배속. 장면이 `speed`로 덮어쓸 수 있다.
 *
 * **프레임을 버리는 것이 아니라 시간축을 줄인다.** 커서가 목표로 옮겨 가고
 * 눌리는 궤적은 그대로 남고 빨라지기만 한다 — 잘라 내는 것(`from`/`to`)과
 * 다른 손잡이다. 프레임 수가 같은 비율로 줄어 용량도 같이 준다.
 *
 * 2.0이 상한이다. 조작 하나가 `press`의 `hover 450 + 450 + click + 700`에
 * `slowMo` 220 둘을 더해 약 1.6초인데, 2.0배면 0.8초로 남는다. 3.0배(0.53초)
 * 부터는 무엇을 눌렀는지가 프레임에 안 남는다 — `press`를 만든 이유가
 * 그것이라(`e2e/fixtures/screen.ts`) 배속으로 되돌리면 뜻이 없다.
 */
const SPEED = 2;

/**
 * 자막에 쓰는 폰트. 한글이 있어야 하므로 후보를 훑는다.
 *
 * **없으면 멈춘다.** 조용히 자막을 빼면 조각의 경계가 사라져 「이게 어느
 * 문인가」를 읽을 수 없는 그림이 나가는데, 그것은 실패가 아니라 **다른
 * 그림**이라 아무도 못 잡는다.
 */
function captionFont() {
  const candidates = [
    'C:/Windows/Fonts/malgun.ttf',
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      [
        '자막에 쓸 한글 폰트를 못 찾았다. 찾아본 자리:',
        ...candidates.map((p) => `  ${p}`),
        '',
        '이 목록에 이 기계의 폰트를 더한다.',
      ].join('\n'),
    );
  }
  // ffmpeg 필터 문법에서 `:`는 인자 구분자이고 `\`는 escape다. Windows
  // 경로가 둘 다 들고 있어서 그대로 넣으면 필터 그래프가 깨진다.
  return found.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * 장면 하나를 애니메이션 WebP로 만든다.
 *
 * **타일마다 시계가 다르다.** 면마다 0초가 다르다는 것은 처음부터 그랬고
 * (`surfaces.ts`의 슬레이트), 여기에 **실행마다 0초가 다르다**가 더해졌다.
 * 그래서 `from`/`to`는 이름으로 두고, 그 이름이 몇 초인지는 **그 타일이 속한
 * 실행의 `timeline.json`**에서 각자 읽는다.
 *
 * 길이가 어긋나면 `tpad`이 뒤를 채운다. 실행 둘의 마무리 구간이 같은 초일
 * 이유가 없고, **`hstack`은 가장 짧은 입력에서 끝난다** — 채우지 않으면 긴
 * 쪽의 뒷부분이 통째로 잘린다.
 *
 * **그 채움은 정지 화면이라 적을수록 좋다.** 실행마다 창을 따로 주는
 * `windowsByTake`가 그것을 줄이는 자리다 — 짧은 쪽 실행의 창을 한 마크 앞에서
 * 열면 정지가 그만큼 짧아진다. **애초에 기다릴 이유가 없는 둘이면 `parts`로
 * 시간축에 세운다** — 그때는 `tpad`이 0이 된다.
 *
 * @param takes 실행 이름 → `{ dir, timeline }`
 */
function buildScene(scene, takes) {
  const parts = partsOf(scene);
  const inputs = [];
  const filters = [];
  const partLabels = [];
  // 조각끼리 크기가 다르면 `concat`이 거부한다. 어느 조각이 어긋났는지는
  // ffmpeg가 말해 주지 않으므로 여기서 먼저 본다.
  const partSizes = [];
  // 조각 길이의 **합**이 결과물의 길이다. 조각끼리는 서로를 기다리지 않으므로
  // 가장 긴 것이 아니라 이어 붙인 값이다.
  const partSeconds = [];
  const speed = scene.speed ?? SPEED;
  let n = 0;

  parts.forEach((part, p) => {
    // 이 조각이 건드리는 실행마다 구간을 먼저 잰다. 타일이 여섯이어도 실행은
    // 둘이므로, 타일마다 다시 재면 같은 값을 여러 번 읽는다.
    const used = new Set(part.rows.flat().map((t) => t.take ?? part.take));
    const spans = new Map();
    for (const name of used) {
      const entry = takes.get(name);
      if (!entry) throw new Error(`${scene.out}: "${name}" 촬영이 없다.`);
      const segments = segmentsOf(part, name, entry.timeline);
      spans.set(name, {
        segments,
        total: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
      });
    }

    // 가장 긴 구간에 맞춘다. 짧은 쪽은 마지막 프레임을 늘려 채운다.
    // **조각 하나 안에서만** 맞춘다 — 조각끼리는 시간축이 이어지므로 서로를
    // 기다릴 이유가 없고, 그것이 `parts`를 만든 이유다.
    const longest = Math.max(...[...spans.values()].map((s) => s.total));
    // 보고에만 배속을 먹인다. `longest` 자체는 **촬영에서의** 길이라야
    // 아래 `tail`(짧은 쪽을 늘려 채우는 양)이 같은 시간축에서 계산된다.
    partSeconds.push(longest / speed);

    // 행마다 폭이 같아야 `vstack`이 붙는다. 어긋나면 ffmpeg가 실패하는데,
    // 그 메시지로는 어느 장면의 어느 행인지 알 수 없어 여기서 먼저 본다.
    const rowWidths = part.rows.map((row) => row.reduce((w, t) => w + t.width, 0));
    if (new Set(rowWidths).size > 1) {
      throw new Error(`${scene.out}: 행마다 폭이 다르다 (${rowWidths.join(' · ')}).`);
    }

    assertEvenTiles(part);
    partSizes.push([
      rowWidths[0],
      part.rows.reduce((h, row) => h + row[0].height, 0),
    ]);

    const rowLabels = [];
    part.rows.forEach((row, r) => {
    const cells = [];
    for (const t of row) {
      const takeName = t.take ?? part.take;
      const { dir, timeline } = takes.get(takeName);
      const { segments, total } = spans.get(takeName);

      const file = join(dir, `${t.label}.webm`);
      if (!existsSync(file)) throw new Error(`영상이 없다: ${file}`);
      inputs.push('-i', file);

      // 촬영 시각을 이 파일의 시각으로 옮긴다. 면이 그 장면 도중에 열렸으면
      // 앞부분은 검은 화면으로 채운다 — 그 순간의 그림이 아예 없다.
      const surface = surfaceEntry(timeline, t.label, file);
      // 앞을 검게 채우는 만큼. 슬레이트를 건너뛴 만큼 그림이 늦게 시작하므로
      // 그 몫까지 채운다 — 아니면 이 타일만 옆 타일보다 앞서 간다.
      const first = segments[0];
      const lead = Math.max(
        0,
        Math.min(surface.openedAt + surface.firstFrameAt, first.end) - first.start,
      );
      // **면이 창 도중에 열리는 것과 도려내기는 같이 못 쓴다.** 검게 채우는
      // 몫은 첫 구간에만 붙는데, 뒤 구간이 아직 안 열린 면을 가리키면 그
      // 구간이 길이 0으로 나와 `concat`이 프레임 없는 입력을 받는다. 그런
      // 조합이 필요해지면 구간마다 채우도록 고쳐야 한다 — 지금은 조용히
      // 깨지는 대신 여기서 멈춘다.
      if (segments.length > 1 && lead > 0) {
        throw new Error(
          `${scene.out}: 면 "${t.label}"이 창 도중에 열리는데 구간이 여럿이다. ` +
            '면을 더 일찍 열거나 구간을 하나로 둔다.',
        );
      }
      // 이 실행의 구간이 가장 긴 것보다 짧으면 뒤를 늘린다. `stop_mode=clone`
      // 은 마지막 프레임을 복제한다 — 마무리 구간의 끝은 대회가 닫힌 뒤라
      // 거의 정지 화면이고, 늘어난 몇 초가 그림을 바꾸지 않는다.
      // `stop_duration=0`은 아무 일도 안 하므로 가장 긴 실행에는 무해하다.
      const tail = longest - total;
      // 구간마다 잘라 이어 붙인다. 하나면 `concat` 없이 그대로 간다 —
      // 필터 그래프가 짧을수록 실패했을 때 읽기 쉽다.
      let cut = `[${n}:v]`;
      if (segments.length === 1) {
        // **슬레이트보다 앞을 집지 않는다.** 그 면이 장면 도중에 열렸으면
        // `toVideoTime`이 0을 주는데, 영상의 0초는 그림이 아니라 자홍색
        // 마커다(`firstFrameAt`).
        const from = Math.max(toVideoTime(surface, first.start), surface.firstFrameAt);
        const to = Math.max(toVideoTime(surface, first.end), from);
        cut += `trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS,`;
      } else {
        filters.push(`[${n}:v]split=${segments.length}${segments.map((_, i) => `[s${n}_${i}]`).join('')}`);
        for (const [i, seg] of segments.entries()) {
          const from = Math.max(toVideoTime(surface, seg.start), surface.firstFrameAt);
          const to = Math.max(toVideoTime(surface, seg.end), from);
          filters.push(
            `[s${n}_${i}]trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS[c${n}_${i}]`,
          );
        }
        filters.push(
          `${segments.map((_, i) => `[c${n}_${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[j${n}]`,
        );
        cut = `[j${n}]`;
      }
      filters.push(
        cut +
          `tpad=start_duration=${lead.toFixed(3)}:start_mode=add:color=black` +
          `:stop_duration=${tail.toFixed(3)}:stop_mode=clone,` +
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
    filters.push(`${cells.join('')}hstack=inputs=${cells.length}[r${p}_${r}]`);
    rowLabels.push(`[r${p}_${r}]`);
    });

    let grid = rowLabels[0];
    if (rowLabels.length > 1) {
      filters.push(`${rowLabels.join('')}vstack=inputs=${rowLabels.length}[g${p}]`);
      grid = `[g${p}]`;
    }

    // **fps는 조각마다 건다.** `concat`은 프레임을 이어 붙일 뿐 시간 축을
    // 다시 재지 않으므로, 조각끼리 레이트가 다르면 뒤 조각의 재생 속도가
    // 어긋난다.
    //
    // 배속은 **`fps` 앞**이다. 뒤에 두면 이미 목표 레이트로 고른 프레임의
    // 타임스탬프만 줄어들어 출력 레이트 메타가 어긋난다. 앞에 두면 `fps`가
    // 줄어든 시간축 위에서 다시 고른다. 격자를 쌓은 **뒤**에 한 번만 거는
    // 이유는, 입력마다 걸면 `tpad`으로 맞춰 둔 조각 안의 정렬이 깨지기
    // 때문이다.
    let chain = `${grid}setpts=PTS/${speed},fps=${scene.fps}`;
    if (part.caption) {
      /*
        **자막 크기는 결과물 기준이다.**

        자막은 합쳐진 원본 해상도에 그려지고 그 뒤 `scene.width`로 줄어드는데,
        그 축소율이 프레임마다 다르다 — 1760→1000(0.57)과 1440→1200(0.83)이
        같이 있다. 고정 크기로 그리면 최종 글자가 17px과 25px로 갈리고,
        **읽으라고 넣은 문구가 프레임에 따라 안 읽힌다.**

        그래서 축소율만큼 미리 키운다. 띠 높이도 같이 키워야 글자와 여백의
        비율이 유지된다.
      */
      const shrink = partSizes[p][0] / scene.width;
      const band = Math.round(CAPTION_BAND * shrink);
      const size = Math.round(CAPTION_SIZE * shrink);
      /*
        **넘치면 조용히 잘린다.** `drawtext`는 폭을 벗어난 글자를 그냥 안
        그리고 아무 말도 하지 않는다 — 실제로 44자짜리 문구가 「…엔트리만」
        에서 끊긴 채 나갔고, 그것이 결과물을 열어 보기 전까지 안 보였다.

        한글은 글자 폭이 `fontsize`와 거의 같다. 자간과 여백까지 보수적으로
        잡아 **결과물 기준 글자 수**로 센다 — 여기서 재는 것은 원본 폭이
        아니라 「1000px 그림에 30px 글자가 몇 개 들어가는가」다.
      */
      const fits = Math.floor((scene.width - 48) / CAPTION_SIZE);
      if ([...part.caption].length > fits) {
        throw new Error(
          `${scene.out}: 자막이 ${[...part.caption].length}자라 잘린다 (최대 ${fits}자). ` +
            `「${part.caption}」`,
        );
      }
      // 그림 **위로 덧붙인다.** 얹으면 그 순간의 숫자를 가리는데, 이 그림들이
      // 주장하는 것이 전부 숫자다.
      partSizes[p][1] += band;
      chain +=
        `,pad=w=iw:h=ih+${band}:x=0:y=${band}:color=0x141414` +
        `,drawtext=fontfile='${captionFont()}':text='${part.caption}'` +
        `:fontcolor=0xf0f0f0:fontsize=${size}:x=${Math.round(24 * shrink)}` +
        `:y=${Math.round((band - size) / 2)}`;
    }
    filters.push(`${chain}[p${p}]`);
    partLabels.push(`[p${p}]`);
  });

  const [w0, h0] = partSizes[0];
  const mismatch = partSizes.findIndex(([w, h]) => w !== w0 || h !== h0);
  if (mismatch > 0) {
    throw new Error(
      `${scene.out}: 조각 ${mismatch + 1}의 크기가 첫 조각과 다르다 ` +
        `(${partSizes[mismatch].join('×')} ≠ ${w0}×${h0}). ` +
        'concat은 같은 크기만 잇는다.',
    );
  }

  let joined = partLabels[0];
  if (partLabels.length > 1) {
    filters.push(`${partLabels.join('')}concat=n=${partLabels.length}:v=1:a=0[j]`);
    joined = '[j]';
  }
  filters.push(`${joined}scale=${scene.width}:-2:flags=lanczos[out]`);

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
    //
    // **긴 장면만 내린다.** 프레임 ①은 108초짜리 4분할이라 85에서 5MB가
    // 넘었다. 그 프레임에 빠른 움직임이 없어(사람이 사라지고 숫자가 떨어진다)
    // 잔상이 생길 자리도 없다.
    '-q:v',
    String(scene.quality ?? 85),
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
    `  ${scene.out}.webp  ${partSeconds.reduce((a, b) => a + b, 0).toFixed(1)}초` +
      (partSeconds.length > 1
        ? ` (조각 ${partSeconds.map((v) => v.toFixed(1)).join(' + ')})`
        : '') +
      ` · 면 ${n} · ${scene.fps}fps · ${mib(out)}MB`,
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
function settlementStills() {
  return [
    '16-four-tables-rake-10.png',
    // `12-rebuy-accept-raises-entry.png`이 여기 있었다. 그 스틸을 찍는
    // 자리가 **서버의 리바인 창 15초 안**이라 스크린샷 한 장이 예산을
    // 갉았고, 늦게 누른 리바인이 조용히 사라져 촬영이 죽었다
    // (`settlement.spec.ts`의 리바인 블록). 리바인 오버레이는 움짤
    // `11-entry-not-player`가 이미 담는다.
    '13-entry-36-players-35.png',
    '04-prize-table-locked.png',
    '17-final-table-origins.png',
    '18-finish-blocked-reasons.png',
    // 확인 대화는 그 마무리를 실제로 돌린 실행에만 열린다. `.shots/`는 실행
    // 사이에 안 지워지므로 셋을 다 돌고 나면 셋이 다 거기 있다 — 갈림목 전에
    // 찍는 것들은 마지막 실행이 덮어쓰지만, 그 구간은 세 실행이 같다.
    '19-chop-ledger-sums.png',
    '21-abort-ledger-groups.png',
    '22-closed-complete.png',
    '23-closed-chop.png',
    '24-closed-abort.png',
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
 * `--settlement`은 **인자를 안 받는다.**
 *
 * 마무리 프레임이 `chop`과 `complete`를 좌우로 놓으므로 셋이 다 있어야
 * 자를 수 있다. 하나만 골라 자를 수 있게 두면 **반만 있는 그림이 조용히
 * 나온다** — 없는 촬영을 가리키는 타일이 검게 채워질 뿐 실패하지 않는다.
 */
const settlement = process.argv.includes('--settlement');

assertFfmpeg();
mkdirSync(ASSETS, { recursive: true });

const scenes = settlement ? settlementScenes() : SCENES;
const stills = settlement ? settlementStills() : STILLS;

// 장면이 가리키는 실행을 다 읽는다. 정산은 셋, 장면 1~5는 하나다.
const takes = new Map();
if (settlement) {
  for (const [ending, folder] of Object.entries(SETTLEMENT_TAKE)) {
    takes.set(ending, loadTimeline(folder));
  }
} else {
  takes.set(TAKE, loadTimeline(TAKE));
  for (const scene of SCENES) scene.take = TAKE;
}

console.log('움짤');
for (const scene of scenes) buildScene(scene, takes);
console.log('스틸');
copyShots(stills);
