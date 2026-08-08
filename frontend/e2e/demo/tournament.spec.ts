import { Page } from '@playwright/test';
import { join, resolve } from 'path';
import {
  chipsOnTable,
  login,
  seat,
  tableState,
  type DemoTableState,
} from '../fixtures/backstage';
import { playerAt, tableByOrder } from '../fixtures/manifest';
import { expect, test } from '../fixtures/surfaces';

/**
 * 데모 촬영. 장면 다섯을 한 대회 위에서 이어서 돌린다.
 *
 * 설계는 `docs/superpowers/specs/2026-08-08-readme-demo-design.md`에 있다.
 * 여기서 지키는 규칙 셋만 옮겨 적는다.
 *
 * **증명하는 것은 "돌아간다"가 아니라 "정합이 무너지지 않는다"다.** 돌아간다는
 * 것은 V1이 이미 보였다. 그래서 장면마다 짝이 되는 시나리오 테스트가 있고,
 * 단계마다 칩 총량을 확인한다 — 틀어지면 **거기서 촬영을 멈춘다.**
 *
 * **스택을 손으로 벌리지 않는다.** 승자를 딜러가 입력하므로 누가 이길지는
 * 촬영이 통제할 수 있다. 워밍업 핸드를 돌려 자연히 벌린다. 그래야 화면에
 * 보이는 모든 숫자가 화면에서 벌어진 일의 결과다.
 *
 * **장면 다섯이 테스트 하나다.** 좌석이 컨텍스트에 매여 있기 때문이다 — 자리에
 * 앉으면 좌석 토큰이 그 태블릿의 쿠키로 심기고, 테스트가 끝나 컨텍스트가
 * 닫히면 새 컨텍스트는 그 자리를 다시 잡을 수 없다(이미 사람이 앉아 있어서
 * 대기 화면의 그 자리가 점선으로 잠긴다). 실제 운영에서 태블릿이 자리에
 * 고정돼 있는 것과 같은 제약이다. **자르는 것은 ffmpeg가 한다** — 경계는
 * `mark()`가 `recordings/<제목>/timeline.json`에 시각으로 남긴다.
 *
 * 회귀(`e2e/*.spec.ts`)와 프로젝트가 갈려 있다. 이건 `npm run demo`로 돈다 —
 * 시드를 먼저 깐다.
 */

/** 착석 배치. 1번 테이블 셋이 사이드팟 판을 만든다. */
const SEATS = {
  /** 화면으로 앉는다. 시드에서 결제 전이라 참가부터 찍는다. 워밍업에서 진다. */
  hero: 0,
  p1: 2,
  p2: 4,
} as const;

/**
 * 2번 테이블. 장면 5에서 통째로 1번으로 옮겨 온다.
 *
 * 셋이다. 콘솔에서 좌석 도식을 볼 때 **한 테이블이 통째로 비는 것**이
 * 사건이라, 하나만 앉혀 두면 "자리 하나 옮겼다"로 보인다.
 */
const TABLE2_SEATS = { p3: 1, p4: 5, p5: 7 } as const;

/** 장면 5에서 옮겨 온 사람들이 앉을 1번 테이블의 빈 자리. */
const MOVED_SEATS = { p3: SEATS.p1, p4: 6, p5: 8 } as const;

/**
 * 시드가 만드는 참가 OTP 길이만큼 키패드를 누른다.
 *
 * 자리마다 조금씩 쉰다. 여덟 자리를 순식간에 채우면 영상에서는 번호가 그냥
 * "나타난다" — 폰이 보여준 번호가 이 키패드로 들어가는 것이 장면 1의 전부다.
 */
async function typeOtp(page: Page, otp: string) {
  for (const digit of otp) {
    // `press`를 쓰지 않는다. hover와 click이 각각 `slowMo`(220ms)를 물어서
    // 한 자리에 0.6초가 걸렸다 — 여덟 자리면 5초다. 클릭 하나면 커서가 그
    // 키로 옮겨 가고 파문도 그대로 남으므로 눌린 것은 여전히 보인다.
    await page.getByRole('button', { name: digit, exact: true }).click();
    await page.waitForTimeout(80);
  }
}

/**
 * 누르는 것을 **보이게** 누른다.
 *
 * 커서를 먼저 목표 위로 옮기고(=영상에서 커서가 그리로 간다), 한 박자 쉬고,
 * 누르고, 결과를 볼 시간을 준다. `click()`은 커서를 순간이동시킨 뒤 곧바로
 * 누르므로 **무엇을 눌렀는지가 프레임에 남지 않는다** — 첫 촬영본에서
 * "무슨 조작을 했는지 확인이 안 된다"는 지적이 그것이다.
 *
 * `slowMo`를 더 올리는 것으로는 해결되지 않는다. 그건 모든 입력을 균일하게
 * 늦춰서 키패드 여덟 번에도 같은 시간을 쓴다.
 */
async function press(
  page: Page,
  target: ReturnType<Page['getByRole']>,
  before = 450,
  after = 700,
) {
  await target.hover();
  await page.waitForTimeout(before);
  await target.click();
  await page.waitForTimeout(after);
}

/** 좌석 태블릿 하나를 열어 자리에 앉힌다. 컨텍스트가 새로 열릴 때마다 필요하다. */
async function sitDown(
  page: Page,
  storeId: string,
  tableId: string,
  seatIndex: number,
  otp: string,
  /** 키패드가 뜬 상태의 스틸을 여기서 찍는다(화면 2). */
  shotName?: string,
) {
  await page.goto(`/table?store=${storeId}`);
  await linger(page, 900);
  await press(page, page.getByTestId(`pick-table-${tableId}`));
  await press(page, page.getByTestId(`pick-seat-${seatIndex}`));
  if (shotName) await shoot(page, shotName);
  await typeOtp(page, otp);
  await linger(page, 700);
  await press(page, page.getByRole('button', { name: /참가/ }));
  await page.waitForURL(`**/table/${tableId}`);
  await linger(page, 1_200);
}

/**
 * 딜러 태블릿을 켠다. 딜러가 오기 전에도 이 기기는 테이블 고르는 화면을
 * 띄우고 있다 — 좌석 태블릿이 대기 화면을 띄우고 있는 것과 같다.
 */
async function openDealerTablet(page: Page, storeId: string) {
  // 소켓이 안 열린 채로 누른 딜러 조작은 **조용히 사라진다**
  // (`sendDealerAction`이 `console.error`만 찍는다). 그 사실이 촬영에서
  // 보이도록 콘솔을 걷어 둔다.
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.log(`[딜러 콘솔 에러] ${msg.text()}`);
    }
  });
  await page.goto(`/dealer?store=${storeId}`);
}

/** 딜러가 와서 OTP로 그 테이블의 딜러 화면까지 들어간다. */
async function enterDealer(page: Page, storeId: string, tableId: string, dealerOtp: string) {
  await page.goto(`/dealer?store=${storeId}`);
  await press(page, page.getByTestId(`pick-table-${tableId}`));
  await typeOtp(page, dealerOtp);
  await press(page, page.getByRole('button', { name: /인증/ }));
  await page.waitForURL(`**/dealer/table/${tableId}`);
}

/**
 * 딜러 조작 하나를 누르고, **그것이 실제로 먹을 때까지** 다시 누른다.
 *
 * 딜러 화면은 SSR 스냅샷으로 펠트를 먼저 그리고 WebSocket은 그 뒤에 붙는다.
 * 그 사이에 누른 버튼은 `sendDealerAction`의 `readyState !== OPEN` 가지로
 * 빠져 **아무 일도 일어나지 않는다** — 예외도 없고 화면도 그대로다. 실제로
 * 이 촬영이 그 구멍으로 한 번은 조용히 통과했고(팟 0, 차례 -1) 한 번은
 * 20초를 기다리다 죽었다.
 *
 * 그래서 "눌렀다"가 아니라 **"상태가 바뀌었다"를 성공으로 삼는다.**
 */
async function pressUntilEffective(
  page: Page,
  buttonName: string | RegExp,
  settled: () => Promise<boolean>,
  attempts = 6,
) {
  for (let i = 0; i < attempts; i++) {
    await press(page, page.getByRole('button', { name: buttonName }));
    for (let waited = 0; waited < 10; waited++) {
      await page.waitForTimeout(500);
      if (await settled()) return;
    }
  }
  throw new Error(`"${buttonName}"을 ${attempts}번 눌러도 상태가 바뀌지 않았다.`);
}

/**
 * 정지 사진. 움짤로 설명되지 않는 것 — 한 화면의 밀도와 배치 — 은 스틸이 낫다.
 *
 * 촬영 중에 찍는다. 나중에 다시 열어 찍으려면 그 화면에 도달한 상태를 다시
 * 만들어야 하는데, 좌석은 이미 사람이 앉아 잠겨 있고 사이드팟 층은 특정
 * 핸드의 한순간에만 존재한다.
 *
 * `deviceScaleFactor`를 2로 올리지 않는다(명세 §7과 다르다). 그건 컨텍스트
 * 단위 설정이라 녹화 중인 면 일곱의 래스터가 통째로 4배가 되는데, 이 기계는
 * 여유 RAM이 0.93GB다. 1280×720 PNG가 README 폭(약 900px)에서 뭉개지지
 * 않는다.
 */
const SHOTS_DIR = resolve(__dirname, '../.shots');
async function shoot(page: Page, name: string) {
  await page.screenshot({
    path: join(SHOTS_DIR, `${name}.png`),
    animations: 'disabled',
    caret: 'hide',
  });
}

/**
 * 카메라를 위해 한 박자 쉰다.
 *
 * 판정에는 필요 없다 — **읽히는 데 필요하다.** 첫 촬영에서 장면 3이 5초,
 * 폰의 순위 화면이 0.9초에 지나갔다. 거부 배너처럼 한 프레임에 스치는 것은
 * 영상에서 없는 것과 같고, 이 데모가 증명하려는 것이 바로 그 순간들이다.
 *
 * `slowMo`를 더 올리지 않는 이유: 그건 모든 클릭을 균일하게 늦춰서 키패드
 * 여덟 번 누르는 데까지 시간을 쓴다. 멈춰야 할 곳은 정해져 있다.
 */
async function linger(page: Page, ms = 1_800) {
  await page.waitForTimeout(ms);
}

/** 토큰을 쿠키로 심고 그 화면을 연다. 로그인 자체는 카메라 밖이다. */
async function openWithToken(page: Page, token: string, url: string) {
  // 쿠키를 goto보다 먼저 심는다. `/stores`는 미들웨어의 역할 규칙이 걸린
  // 경로라, 순서를 바꾸면 첫 요청이 로그인으로 튕긴다.
  await page.context().addCookies([
    { name: 'accessToken', value: token, domain: 'localhost', path: '/' },
  ]);
  await page.goto(url);
}

/**
 * 칩 총량이 그대로인지 본다. 어긋나면 **그 자리에서** 멈춘다.
 *
 * 값을 문자열로 감싸는 이유는 시나리오 계층과 같다 — 실패 메시지에 단계
 * 이름이 남아야 어디서 틀어졌는지 알 수 있다.
 */
function expectChips(state: DemoTableState, step: string, total: number) {
  expect(`${step} 칩 총량 ${chipsOnTable(state)}`).toBe(`${step} 칩 총량 ${total}`);
}

/** `GamePhase`. 프론트 enum을 e2e가 import하지 않는다 — 값만 쓴다. */
const PHASE = { WAITING: 0, SHOWDOWN: 5, HAND_END: 6 } as const;

type Choice =
  | { kind: 'fold' }
  | { kind: 'passive' } // 체크할 수 있으면 체크, 아니면 콜
  | { kind: 'allin' }
  | { kind: 'raise'; amount: number };

/** 좌석 태블릿 하나에서 액션 하나를 누른다. */
async function clickAction(page: Page, choice: Choice) {
  if (choice.kind === 'fold') {
    await press(page, page.getByRole('button', { name: '폴드' }));
    return;
  }
  if (choice.kind === 'allin') {
    // 콜만 해도 스택이 다 들어가는 자리에서는 패널이 `올인 콜` 하나만 그린다.
    const allInCall = page.getByRole('button', { name: '올인 콜' });
    if (await allInCall.isVisible().catch(() => false)) {
      await press(page, allInCall);
      return;
    }
    await press(page, page.getByRole('button', { name: '올인', exact: true }));
    return;
  }
  if (choice.kind === 'raise') {
    // `amount`는 총 베팅액이다. 슬라이더 step이 빅블라인드라 그 배수로 맞춰
    // 넣어야 값이 그대로 들어간다. 슬라이더가 움직이는 것도 조작이라
    // 채운 뒤 한 박자 쉰다 — 레이즈 금액이 어디서 나왔는지 보여야 한다.
    const slider = page.locator('input[type=range]');
    await slider.hover();
    await slider.fill(String(choice.amount));
    await page.waitForTimeout(900);
    await press(page, page.getByRole('button', { name: /^레이즈/ }));
    return;
  }
  const check = page.getByRole('button', { name: '체크' });
  if (await check.isVisible().catch(() => false)) {
    await press(page, check);
    return;
  }
  await press(page, page.getByRole('button', { name: /^콜/ }));
}

/**
 * 핸드 하나를 쇼다운까지 몬다.
 *
 * 화면을 긁어 차례를 알아내지 않는다 — 스냅샷의 `currentTurnSeatIndex`가
 * 진실이고, 그것이 가리키는 자리의 태블릿에서 누른다. **차례가 하나뿐이라는
 * 사실 자체가 이 루프의 전제**다.
 *
 * `decide`는 자리마다 무엇을 누를지 정한다. 첫 액션과 그 뒤가 다를 수 있어
 * (레이즈는 한 번만) 호출 횟수를 넘겨준다.
 */
async function driveToShowdown(opts: {
  request: Parameters<typeof tableState>[0];
  tableId: string;
  token: string;
  total: number;
  step: string;
  pageBySeat: Record<number, Page>;
  decide: (seatIndex: number, actedCount: number, state: DemoTableState) => Choice;
}) {
  const acted: Record<number, number> = {};

  for (let guard = 0; guard < 40; guard++) {
    const state = await tableState(opts.request, opts.tableId, opts.token);
    if (state.phase === PHASE.SHOWDOWN || state.phase === PHASE.WAITING) return state;

    const seatIndex = state.currentTurnSeatIndex;
    // 전원이 올인하면 남은 스트리트에 차례가 없다. 서버가 지름길로 쇼다운에
    // 가는 중이라, 여기서 누를 것은 없고 기다리면 된다.
    if (seatIndex < 0) return state;

    const page = opts.pageBySeat[seatIndex];
    if (!page) throw new Error(`${seatIndex}번 자리의 태블릿이 없다. 차례가 멈춘다.`);

    const n = acted[seatIndex] ?? 0;
    const choice = opts.decide(seatIndex, n, state);

    // **좌석 액션도 조용히 사라진다.** `sendPlayerAction`이 딜러 쪽과 같은
    // `readyState !== OPEN` 가지를 갖고 있어서(`SeatGameClient.tsx`), 소켓이
    // 붙기 전이나 끊긴 뒤에 누른 것은 `console.error` 하나만 남기고 없던 일이
    // 된다. 첫 촬영에서 워밍업 첫 액션이 그렇게 사라져 15초를 기다리다
    // 죽었다. 그래서 딜러와 같은 규칙을 쓴다 — **"눌렀다"가 아니라 "차례가
    // 넘어갔다"를 성공으로 삼는다.**
    let moved = false;
    for (let attempt = 0; attempt < 3 && !moved; attempt++) {
      await clickAction(page, choice);
      for (let waited = 0; waited < 16; waited++) {
        await page.waitForTimeout(500);
        const s = await tableState(opts.request, opts.tableId, opts.token);
        if (s.currentTurnSeatIndex !== seatIndex || s.phase === PHASE.WAITING) {
          moved = true;
          break;
        }
      }
    }
    if (!moved) {
      throw new Error(`${opts.step}: ${seatIndex}번 자리에서 누른 것이 먹지 않는다.`);
    }
    acted[seatIndex] = n + 1;

    // 매 액션마다 본다. 마지막에 한 번만 보면 틀어진 첫 순간을 놓친다.
    expectChips(
      await tableState(opts.request, opts.tableId, opts.token),
      `${opts.step} ${seatIndex}번 자리 액션 후`,
      opts.total,
    );
  }
  throw new Error(`${opts.step}: 40수 안에 쇼다운에 못 갔다`);
}

test.describe('데모 — 한 대회', () => {
  /**
   * 장면 다섯이 테스트 하나다(파일 머리글). 각 장면의 화면·정합·짝 테스트는
   * 명세 §5에 있고, 여기서는 그 순서대로 판을 몬다.
   */
  test('장면 1~5 — 한 대회', async ({ stage, mark, manifest, request }) => {
    const table1 = tableByOrder(manifest, 1);
    const table2 = tableByOrder(manifest, 2);
    const ownerToken = await login(request, 'owner', manifest.password);
    // 이름이 아니라 **역할**로 고른다. 시드에서 이름을 고쳐도 여기는 안
    // 바뀐다(`playerAt`). 역할은 워밍업 한 판이 정한다 — 손으로 벌리지 않는다.
    const mid = playerAt(manifest, 0); // 사이드팟 2층에서 져서 탈락한다
    const deep = playerAt(manifest, 1); // 워밍업과 2층을 먹는다
    const mover = playerAt(manifest, 2); // 2번 테이블 → 1번으로 걸어온다(A)
    const mover2 = playerAt(manifest, 3); // 같이 옮기지만 카메라 밖이다
    const mover3 = playerAt(manifest, 4); // 위와 같다
    const consoleUrl = `/stores/${manifest.store.id}/tournaments/${manifest.tournament.id}`;

    // =====================================================================
    // 장면 1 — 사람이 대회에 들어간다
    //
    // **폰 → 좌석 태블릿 → 콘솔**이 한 사람을 각자의 자리에서 가리키는 것이
    // 이 장면이다. 폰만 찍고 콘솔을 붙이면 "그 번호가 어디로 들어갔는가"가
    // 빠져서 아무 말도 하지 않는 그림이 된다.
    // =====================================================================
    /*
      면을 **처음부터 켜 둔다.** 상점 콘솔은 대회 내내 열려 있고 좌석
      태블릿은 자리에 고정돼 대기 화면을 띄운 채로 사람을 기다린다 —
      운영이 실제로 그렇다.

      촬영에도 그래야 하는 이유가 하나 더 있다. 녹화는 **첫 화면이 그려질
      때** 시작하므로, 빈 탭으로 두었다가 나중에 여는 면은 앞부분이 통째로
      비어 그 자리에 검은 화면이 붙는다.
    */
    const phone = await stage('phone', 'phone');
    const console_ = await stage('console', 'console');
    await openWithToken(console_, ownerToken, consoleUrl);

    const p1Page = await stage('tablet', 'seat-p1');
    const heroPage = await stage('tablet', 'seat-hero');
    await heroPage.goto(`/table?store=${manifest.store.id}`);

    // 전광판은 대회 내내 틀어 두는 화면이고, 딜러 태블릿은 딜러가 오기 전에도
    // 테이블 고르는 화면을 띄우고 있다. 둘 다 여기서 켠다.
    const board = await stage('scoreboard', 'scoreboard');
    await openWithToken(board, ownerToken, `${consoleUrl}/display`);
    const dealer = await stage('tablet', 'dealer');
    await openDealerTablet(dealer, manifest.store.id);

    // 0. 옆자리에는 이미 사람이 앉아 있다. 배경이라 카메라가 폰으로 가기
    //    전에 끝내 둔다 — 폰이 번호를 보여준 뒤에 이걸 하면 "번호를 받았는데
    //    한참 딴짓하다 자리로 간다"가 된다.
    await sitDown(p1Page, manifest.store.id, table1.id, SEATS.p1, mid.otp);

    // 1. 폰에서 **상점을 찾는다.** 대회는 상점이 여는 것이라 참가도 상점을
    //    고르는 데서 시작한다 — 이 걸음이 없으면 화면만 보고는 시스템이
    //    상점 하나짜리인지 여럿을 나눠 담는지 알 수 없다.
    await phone.goto('/login');
    mark('장면 1 — 상점을 찾는다');
    await linger(phone, 900);
    await phone.getByLabel('닉네임').fill(manifest.unpaidPlayer);
    await phone.getByLabel('비밀번호').fill(manifest.password);
    await linger(phone, 700);
    await press(phone, phone.getByRole('button', { name: '로그인' }), 400, 900);
    await phone.waitForURL('**/me');
    await linger(phone, 900);

    // 하단 탭으로 간다. 손가락이 닿는 자리가 어디인지가 폰 화면의 설계다.
    await press(phone, phone.getByLabel('주요 메뉴').getByRole('link', { name: '대회' }), 400, 900);
    await phone.waitForURL('**/tournaments**');
    await linger(phone, 900);

    // 상점 이름으로 찾는다. 시드에 다른 상점이 셋 더 있어서 **목록이 실제로
    // 줄어든다** — 하나뿐이면 검색 전후가 같아 검색이 검색으로 보이지 않는다.
    await linger(phone, 1_200);
    await phone.getByLabel('상점 이름').fill('플레이싱크');
    await linger(phone, 700);
    await press(phone, phone.getByRole('button', { name: '검색' }), 400, 1_200);
    await press(phone, phone.getByTestId(`pick-store-${manifest.store.id}`), 500, 1_100);
    await press(phone, phone.getByTestId(`pick-tournament-${manifest.tournament.id}`), 500, 1_100);

    // 2. 참가비를 낸다. 첫 사람은 시드에서 결제 전이라 이 경로가 살아 있다.
    mark('장면 1 — 참가비를 내고 OTP를 받는다');
    await linger(phone, 1_200);
    await press(phone, phone.getByRole('button', { name: /포인트로 참가/ }), 600, 1_200);
    await phone.waitForURL('**/me');
    await linger(phone, 900);

    // 3. 참가 OTP를 조회한다. 이 화면이 OTP를 읽는 유일한 곳이다(T27).
    await press(phone, phone.getByRole('button', { name: '참가 OTP 조회' }), 600, 900);
    const heroOtp = (await phone.getByTestId('player-otp').innerText()).replace(/\s/g, '');
    expect(heroOtp).toMatch(/^\d+$/);
    await shoot(phone, 'phone-me');
    // 폰이 보여준 모양(자릿수만큼 칸)과 태블릿이 요구하는 모양(키패드)이
    // 같다는 것이 이 장면의 그림이다. **곧바로 자리로 간다** — 사이에 다른
    // 일을 끼우면 번호를 들고 걸어가는 흐름이 끊긴다.
    await linger(phone, 1_800);

    // 4. **폰의 번호를 자리의 태블릿에 넣는다.** 장면 1의 한가운데다.
    mark('장면 1 — 태블릿에 그 번호를 넣는다');
    await sitDown(heroPage, manifest.store.id, table1.id, SEATS.hero, heroOtp, 'seat-waiting');
    await linger(heroPage, 1_200);

    // 5. 콘솔의 좌석 도식에 그 사람이 뜬다. 콘솔은 좌석을 폴링하지 않는다 —
    //    자기 조작 뒤에만 `router.refresh()`를 돈다(`ConsoleClient.tsx`).
    mark('장면 1 — 콘솔 좌석 도식에 뜬다');
    await console_.reload();
    await linger(console_, 900);
    await press(console_, console_.getByTestId(`console-pick-table-${table1.id}`));
    await expect(console_.getByTestId(`console-seat-${SEATS.hero}`)).toContainText(
      manifest.unpaidPlayer,
    );
    await shoot(console_, 'console');
    await linger(console_, 1_500);

    // 6. **딜러 OTP를 여기서 꺼낸다.** 참가자의 번호와 딜러의 번호가 다른
    //    번호라는 것, 그리고 딜러 번호는 상점이 쥐고 한 번만 보여준다는 것이
    //    다음 장면(딜러가 그 번호로 테이블에 들어간다)의 전제다.
    mark('장면 1 — 상점이 딜러 OTP를 꺼낸다');
    await press(console_, console_.getByRole('button', { name: '재발급' }), 600, 1_200);
    const shownDealerOtp = (await console_.getByTestId('dealer-otp').innerText()).replace(
      /\s/g,
      '',
    );
    expect(shownDealerOtp).toMatch(/^\d+$/);
    await shoot(console_, 'console-dealer-otp');
    await linger(console_, 2_500);

    // =====================================================================
    // 장면 2 — 대회가 열리고 한 판이 끝난다
    // =====================================================================
    mark('장면 2 — 자리가 찬다');

    const p2Page = await stage('tablet', 'seat-p2');
    await sitDown(p2Page, manifest.store.id, table1.id, SEATS.p2, deep.otp);

    // 2번 테이블. **옮겨 갈 사람(A)에게는 자기 태블릿을 준다** — 장면 5가
    // "A의 자리가 바뀐다"를 보여주는 장면이라, A가 어느 화면에서 나와 어느
    // 화면으로 들어가는지가 보여야 한다. 나머지 둘은 배경이라 API로 앉힌다
    // (태블릿 하나가 컨텍스트당 131MB다).
    const moverPage = await stage('tablet', 'seat-mover');
    await sitDown(moverPage, manifest.store.id, table2.id, TABLE2_SEATS.p3, mover.otp);
    await seat(request, manifest.tournament.id, {
      tableId: table2.id,
      seatIndex: TABLE2_SEATS.p4,
      otp: mover2.otp,
    });
    await seat(request, manifest.tournament.id, {
      tableId: table2.id,
      seatIndex: TABLE2_SEATS.p5,
      otp: mover3.otp,
    });

    const seated = await tableState(request, table1.id, ownerToken);
    // 이 값이 촬영 끝까지 이 테이블의 기준선이다. 사람이 옮겨 오면 그만큼
    // 늘리고(장면 5), 그 밖의 이유로 변하면 거기서 멈춘다.
    let total = chipsOnTable(seated);
    expect(seated.players.filter((p) => p !== null)).toHaveLength(3);

    // --- 무대를 켠다 ---------------------------------------------------
    mark('장면 2 — 대회가 열린다');
    await expect(board.getByText('대기 중')).toBeVisible();

    // **한 클릭이 두 면을 바꾼다.** 콘솔에서 시작을 누르면 전광판이 켜진다.
    // **딜러가 먼저 들어온다.** 대회가 열리기 전에 테이블에 서서 화면을 띄워
    // 두는 것이 실제 순서고, 그래야 다음의 `대회 시작` 한 번이 전광판과 딜러
    // 화면을 같이 바꾸는 것이 보인다.
    //
    // 시드가 알려준 번호가 아니라 **콘솔 화면에서 읽은 번호**를 넣는다.
    // 재발급을 눌렀으므로 시드의 값은 이미 지난 번호다.
    await enterDealer(dealer, manifest.store.id, table1.id, shownDealerOtp);
    await expect(dealer.getByTestId(`seat-${SEATS.hero}`)).toBeVisible();
    await linger(dealer, 1_200);

    // **아직 대회가 열리지 않았다.** 버튼은 눌리지만 서버가 거절하고, 그
    // 사실이 딜러 화면에 모달로 남는다 — 조용히 사라지지 않는 것이 요점이다.
    // (버튼 자체를 잠그려면 딜러 화면이 대회 상태를 실시간으로 알아야 하는데,
    // 스냅샷에 그 정보가 없다. `docs/tickets-next.md` T36에 남겨 뒀다.)
    mark('장면 2 — 대회 전에는 핸드가 열리지 않는다');
    await press(dealer, dealer.getByRole('button', { name: '핸드 시작' }));
    await expect(dealer.getByTestId('dealer-action-error')).toBeVisible({ timeout: 15_000 });
    await shoot(dealer, 'dealer-refused-before-start');
    await linger(dealer, 1_800);
    await press(dealer, dealer.getByRole('button', { name: '확인' }), 300, 400);

    // **한 클릭이 세 면을 바꾼다.** 전광판이 켜지고, 딜러 펠트에는 **버튼(D)이
    // 추첨돼 붙는다** — 그것이 딜러에게 "이제 핸드를 열어도 된다"를 알려 주는
    // 화면 변화다.
    mark('장면 2 — 대회 시작 한 클릭이 세 면을 바꾼다');
    await press(console_, console_.getByRole('button', { name: '대회 시작' }), 700, 500);
    await expect(board.getByText('대기 중')).toBeHidden({ timeout: 30_000 });
    await shoot(board, 'scoreboard');
    // 전광판 폴링이 1초라 여기서 더 기다릴 것이 없다.
    await expect(
      dealer
        .getByTestId(`seat-${SEATS.hero}-button`)
        .or(dealer.getByTestId(`seat-${SEATS.p1}-button`))
        .or(dealer.getByTestId(`seat-${SEATS.p2}-button`)),
    ).toBeVisible({ timeout: 20_000 });
    await linger(dealer, 2_500);

    expectChips(await tableState(request, table1.id, ownerToken), '대회 시작 후', total);

    // --- 워밍업 한 판 --------------------------------------------------
    // 스택을 벌리는 것이 목적이고, 그 자체가 장면이다. 손으로 스냅샷을
    // 고치지 않는다 — 승자를 딜러가 입력하므로 누가 이길지는 여기서 통제한다.
    mark('장면 2 — 핸드가 돈다');
    const pageBySeat: Record<number, Page> = {
      [SEATS.hero]: heroPage,
      [SEATS.p1]: p1Page,
      [SEATS.p2]: p2Page,
    };

    await pressUntilEffective(
      dealer,
      '핸드 시작',
      async () => (await tableState(request, table1.id, ownerToken)).phase !== PHASE.WAITING,
    );

    const reached = await driveToShowdown({
      request,
      tableId: table1.id,
      token: ownerToken,
      total,
      step: '워밍업',
      pageBySeat,
      decide: (seatIndex, n, state) => {
        // hero가 크게 밀고, p1은 접고, p2가 받는다. 그 한 판으로
        // `short < mid < deep`이 만들어진다.
        if (seatIndex === SEATS.hero && n === 0) {
          const me = state.players[seatIndex]!;
          const bb = state.smallBlind * 2;
          const target = Math.min(4000, me.stack + me.bet);
          // 슬라이더 step이 빅블라인드다. 배수로 안 맞추면 값이 튄다.
          return { kind: 'raise', amount: Math.floor(target / bb) * bb };
        }
        if (seatIndex === SEATS.p1) return { kind: 'fold' };
        return { kind: 'passive' };
      },
    });

    // eslint-disable-next-line no-console
    console.log(
      '워밍업 도달 페이즈',
      reached.phase,
      '차례',
      reached.currentTurnSeatIndex,
      '팟',
      reached.pot,
      '스택',
      reached.players.filter((p) => p).map((p) => `${p!.nickname}:${p!.stack}(${p!.bet})`).join(' '),
    );

    // 딜러가 승자를 찍는다. 카드는 테이블 위에 있고 시스템은 장부만 맡는다.
    const showdown = await tableState(request, table1.id, ownerToken);
    const warmupWinnerId = showdown.players[SEATS.p2]!.id;

    await press(dealer, dealer.getByRole('button', { name: '승자 결정' }));
    await press(dealer, dealer.getByTestId(`winner-pick-${warmupWinnerId}`));
    // 배분도 WS로 나간다. 소켓이 끊겨 있으면 오버레이만 닫히고 팟은 그대로다.
    await pressUntilEffective(
      dealer,
      '배분',
      async () => (await tableState(request, table1.id, ownerToken)).phase === PHASE.WAITING,
      3,
    );

    const after = await tableState(request, table1.id, ownerToken);
    expectChips(after, '워밍업 정산', total);

    // 스택이 갈렸다. 이것이 장면 3의 무대다.
    // eslint-disable-next-line no-console
    console.log(
      '워밍업 후 스택',
      Object.fromEntries(after.players.filter((p) => p !== null).map((p) => [p!.nickname, p!.stack])),
      '· 총량',
      chipsOnTable(after),
    );

    const heroStack = after.players[SEATS.hero]!.stack;
    const p1Stack = after.players[SEATS.p1]!.stack;
    const p2Stack = after.players[SEATS.p2]!.stack;
    expect(`short<mid ${heroStack < p1Stack}`).toBe('short<mid true');
    expect(`mid<deep ${p1Stack < p2Stack}`).toBe('mid<deep true');

    // =====================================================================
    // 장면 3 — 올인, 사이드팟, 딜러의 실수를 시스템이 막는다
    //
    // 짝은 `backend/src/scenario/allin-sidepot.int-spec.ts`다. 이 장면은 그
    // 시나리오를 화면으로 옮긴 것이고, 층 구조도 거기서 그대로 나온다.
    // =====================================================================
    mark('장면 3 — 올인');

    await pressUntilEffective(
      dealer,
      '핸드 시작',
      async () => (await tableState(request, table1.id, ownerToken)).phase !== PHASE.WAITING,
    );

    // **상한은 mid의 전 재산이다.** deep이 그보다 더 밀면 아무도 콜하지 못해
    // 환급으로 되돌아오고, 그러면 층이 갈리지 않는다(`allin-sidepot` 2번의
    // 같은 계산).
    const opened = await tableState(request, table1.id, ownerToken);
    const midTotal = opened.players[SEATS.p1]!.stack + opened.players[SEATS.p1]!.bet;

    await driveToShowdown({
      request,
      tableId: table1.id,
      token: ownerToken,
      total,
      step: '사이드팟',
      pageBySeat,
      decide: (seatIndex, _n, state) => {
        const me = state.players[seatIndex]!;
        const myTotal = me.stack + me.bet;
        // 자기 전부가 상한 이하면 그냥 다 민다. short가 먼저 바닥나고 mid가
        // 그 위에 한 층을 더 만든다.
        if (myTotal <= midTotal) return { kind: 'allin' };
        const bb = state.smallBlind * 2;
        const target = Math.floor(midTotal / bb) * bb;
        if (target > state.currentBet) return { kind: 'raise', amount: target };
        return { kind: 'passive' };
      },
    });

    // 전원이 올인하면 남은 스트리트는 차례 없이 흘러간다. 쇼다운에 닿는 것을
    // 기다렸다가 층을 읽는다.
    await expect
      .poll(
        async () => (await tableState(request, table1.id, ownerToken)).phase,
        { timeout: 30_000 },
      )
      .toBe(PHASE.SHOWDOWN);

    const layered = await tableState(request, table1.id, ownerToken);
    expectChips(layered, '올인 쇼다운', total);
    // **사이드팟 합 == 팟.** 갈라놓고 어긋나면 지급에서 증발한다.
    expect(`층 ${layered.sidePots.length}`).toBe('층 2');
    expect(`층 합 ${layered.sidePots.reduce((s, p) => s + p.amount, 0)}`).toBe(`층 합 ${layered.pot}`);
    // 딜러 화면에도 층이 그대로 보인다(`Felt.tsx`). 스틸 `dealer-winner.png`가
    // 이 순간이다.
    await expect(dealer.getByTestId('side-pot-1')).toBeVisible();
    await shoot(dealer, 'dealer-felt');
    await shoot(heroPage, 'seat-game');
    await linger(dealer, 2_500);

    const shortId = layered.players[SEATS.hero]!.id;
    const deepId = layered.players[SEATS.p2]!.id;

    // --- 딜러가 1등만 찍는다 -------------------------------------------
    // T15. 숏스택이 이겼을 때 아래 순위의 승부를 안 찍는 것은 흔한 조작
    // 실수다. 예전에는 그 팟이 조용히 증발했다. **거부 장면이 "정합이
    // 무너지지 않는다"의 가장 직접적인 그림이다.**
    mark('장면 3 — 딜러의 실수를 막는다');
    await press(dealer, dealer.getByRole('button', { name: '승자 결정' }));
    await linger(dealer, 1_500);
    await press(dealer, dealer.getByTestId(`winner-pick-${shortId}`));
    await press(dealer, dealer.getByRole('button', { name: '배분' }));

    await expect(dealer.getByTestId('dealer-action-error')).toContainText('지명되지 않은 팟');
    // **이 데모에서 가장 오래 머무는 화면이다.** 시스템이 사람의 실수를 막는
    // 순간이고, 나머지 장면은 전부 이 한 장면을 위한 무대다.
    await shoot(dealer, 'dealer-refused');
    await linger(dealer, 3_500);
    // 딜러가 읽고 지운다. 모달이라 지우기 전까지는 다음 조작이 막힌다.
    await press(dealer, dealer.getByRole('button', { name: '확인' }));

    // 거부는 아무것도 건드리지 않는다. 딜러가 다시 찍을 수 있어야 한다.
    const refused = await tableState(request, table1.id, ownerToken);
    expectChips(refused, '거부 후', total);
    expect(`거부 후 페이즈 ${refused.phase}`).toBe(`거부 후 페이즈 ${PHASE.SHOWDOWN}`);
    expect(`거부 후 팟 ${refused.pot}`).toBe(`거부 후 팟 ${layered.pot}`);

    // --- 순위대로 다시 찍는다 -------------------------------------------
    mark('장면 3 — 층마다 알맞은 사람에게');
    await press(dealer, dealer.getByRole('button', { name: '승자 결정' }));
    await press(dealer, dealer.getByTestId(`winner-pick-${shortId}`));
    await press(dealer, dealer.getByRole('button', { name: '다음 순위' }));
    await press(dealer, dealer.getByTestId(`winner-pick-${deepId}`));
    // 순위가 두 줄로 쌓인 상태가 화면 6이다. 층이 둘인 팟에 순위가 둘 —
    // 이 그림이 "부기는 시스템이 책임진다"의 전부다.
    await shoot(dealer, 'dealer-winner');
    await linger(dealer, 2_000);
    await dealer.getByRole('button', { name: '배분' }).click();

    // =====================================================================
    // 장면 4 — 탈락과 리바인
    //
    // 짝은 `elimination-rebuy.int-spec.ts`. mid의 스택이 0이 되면서 자연히
    // 이어진다 — 억지로 붙이는 장면이 아니다.
    // =====================================================================
    mark('장면 4 — 리바인을 묻는다');

    // 폰을 미리 이 사람 것으로 바꿔 둔다. 아직 대회가 도는 중이라 화면에는
    // **진행 중인 참가**가 떠 있다 — 그 카드가 곧 등수로 바뀌는 것이 장면
    // 4의 그림이라, 바뀌기 전 상태가 먼저 보여야 한다.
    const midToken = await login(request, mid.nickname, manifest.password);
    await openWithToken(phone, midToken, '/me');
    await linger(phone, 1_500);

    // 배분이 끝나기를 기다리지 않는다. **리바인 대기가 정산 한가운데 있다** —
    // 스택이 0이 된 사람에게 15초를 묻고, 그 답이 와야 판이 `WAITING`으로
    // 돌아간다. 여기서 `pressUntilEffective`로 배분을 다시 누르면 그 대기
    // 구간에 같은 명령을 한 번 더 쏘는 셈이 된다.
    await expect(p1Page.getByRole('button', { name: '리바인' })).toBeVisible({ timeout: 30_000 });
    // 오버레이의 카운트다운이 도는 것이 보여야 한다. 15초 마감이라 짧게 쉰다.
    await shoot(p1Page, 'seat-rebuy');
    // 오래 끌지 않는다. 15초 마감이 도는 것을 보여주는 화면이지 기다리는
    // 화면이 아니고, 답은 이미 정해져 있다(거절 → 탈락).
    await linger(p1Page, 1_000);
    await press(p1Page, p1Page.getByRole('button', { name: '거절' }), 300, 500);

    // 거절은 탈락이다. 태블릿은 순위를 그리지 않고 **다음 사람의 자리**로
    // 돌아간다 — 순위·상금은 사람에게 붙는 정보라 폰이 들고 있다.
    await expect(p1Page.getByText('이 자리에서 나왔습니다')).toBeVisible();
    await linger(p1Page, 2_500);

    await expect
      .poll(
        async () => (await tableState(request, table1.id, ownerToken)).phase,
        { timeout: 30_000 },
      )
      .toBe(PHASE.WAITING);

    const settled = await tableState(request, table1.id, ownerToken);
    expectChips(settled, '사이드팟 정산', total);
    // 층마다 알맞은 사람에게 갔다. mid는 2층의 자격자였지만 지명되지 않아
    // 0이 됐고, 그래서 탈락했다.
    expect(`정산 후 mid 좌석 ${settled.players[SEATS.p1] === null}`).toBe('정산 후 mid 좌석 true');
    const shortAfter = settled.players[SEATS.hero]!.stack;
    const deepAfter = settled.players[SEATS.p2]!.stack;
    // eslint-disable-next-line no-console
    console.log('사이드팟 정산 후', { short: shortAfter, deep: deepAfter, 총량: chipsOnTable(settled) });
    expect(`short가 메인팟을 먹었다 ${shortAfter > 0}`).toBe('short가 메인팟을 먹었다 true');
    expect(`deep이 2층을 먹었다 ${deepAfter > p2Stack - midTotal}`).toBe('deep이 2층을 먹었다 true');

    // 태블릿은 7초 뒤 스스로 대기 화면으로 돌아간다. 기다리는 대신 눌러
    // 다음 장면으로 넘어간다 — 이 자리는 곧 옮겨 온 사람이 앉을 자리다.
    await press(p1Page, p1Page.getByRole('button', { name: '지금 돌아가기' }));
    // 글롭이 아니라 정규식으로 본다 — Playwright 글롭에서 `?`는 쿼리 문자열의
    // 시작이 아니라 한 글자 와일드카드로 읽힌다.
    await p1Page.waitForURL(/\/table\?store=/);

    // --- 폰에서 등수를 본다 ---------------------------------------------
    // 좌석 태블릿이 가리킨 곳이다("순위·상금은 폰에서 확인하세요"). **참가
    // OTP가 아니라 등수**다 — 이 사람의 참가는 끝났고, 다시 앉을 수 없는
    // 번호를 계속 들고 있는 것이 오히려 틀린 화면이다.
    mark('장면 4 — 폰에서 등수를 본다');
    await phone.reload();
    await expect(phone.getByText(/^\d+위$/)).toBeVisible();
    await shoot(phone, 'phone-eliminated');
    await linger(phone, 3_000);

    // =====================================================================
    // 장면 5 — 테이블을 합친다
    //
    // 짝은 `table-move.int-spec.ts`. 사람이 죽어서 인원이 줄었기 때문에 이
    // 장면이 생긴다. **휴식을 기다리지 않는다** — `releaseSeats`가 요구하는
    // 것은 `GamePhase.WAITING`뿐이고(T29), 핸드가 정산되면 테이블이 자연히
    // 그 상태로 돌아온다.
    // 네 단계로 끊어 찍는다. 첫 촬영본이 "무슨 흐름인지 모르겠다"였는데,
    // 콘솔에서 두 번 누르고 태블릿이 갑자기 다른 사람 자리가 되는 것이
    // 전부였기 때문이다. **누가 어디서 어디로 가는지**가 순서대로 보여야 한다.
    // =====================================================================
    mark('장면 5 — 2번 테이블을 통째로 비운다');

    // 면 넷이 이 장면이다. **A의 태블릿**(옮겨 갈 사람) · **B의 태블릿**
    // (1번 테이블에 그대로 앉아 A가 오는 것을 보는 사람) · **콘솔**(자리를
    // 푸는 손) · **폰**(A의 참가 OTP). 자리가 바뀌는 것은 A인데, 그 사실이
    // 네 화면에 각각 다른 모양으로 나타난다.

    // 1. A의 폰에 참가 OTP를 띄운다. 옮겨 앉을 때 넣을 번호이고, **처음
    //    앉을 때 쓴 것과 같은 번호**라는 것이 T27의 요점이다 — 번호는 사람에게
    //    붙지 좌석에 붙지 않는다.
    const moverToken = await login(request, mover.nickname, manifest.password);
    await openWithToken(phone, moverToken, '/me');
    await press(phone, phone.getByRole('button', { name: '참가 OTP 조회' }), 600, 900);
    await linger(phone, 1_500);

    // 2. 콘솔에서 2번 테이블을 연다. 셋이 앉아 있는 도식이 먼저 보여야,
    //    다음 단계에서 **테이블이 통째로 비는 것**이 사건이 된다.
    await console_.reload();
    await press(console_, console_.getByTestId(`console-pick-table-${table2.id}`));
    await expect(console_.getByTestId(`console-seat-${TABLE2_SEATS.p3}`)).toContainText(
      mover.nickname,
    );
    await linger(console_, 1_800);

    // 3. 세 자리를 고른다. 고른 자리가 오른쪽 패널에 이름으로 쌓인다.
    mark('장면 5 — 옮길 자리를 고른다');
    await press(console_, console_.getByTestId(`console-seat-${TABLE2_SEATS.p3}`));
    await press(console_, console_.getByTestId(`console-seat-${TABLE2_SEATS.p4}`));
    await press(console_, console_.getByTestId(`console-seat-${TABLE2_SEATS.p5}`));
    await linger(console_, 1_200);

    // 4. 해제한다. **A의 태블릿이 그 자리에서 나온다** — 탈락과 같은
    //    오버레이지만 탈락이 아니다(칩은 그대로고, 문구도 중립이다).
    mark('장면 5 — 좌석을 해제한다');
    await press(console_, console_.getByRole('button', { name: /고른 자리 해제/ }), 700, 1_200);
    await expect(console_.getByTestId(`console-seat-${TABLE2_SEATS.p3}`)).not.toContainText(
      mover.nickname,
    );
    await expect(moverPage.getByText('이 자리에서 나왔습니다')).toBeVisible({ timeout: 20_000 });
    await linger(moverPage, 1_800);
    await press(moverPage, moverPage.getByRole('button', { name: '지금 돌아가기' }));
    await moverPage.waitForURL(/\/table\?store=/);

    // 5. **A가 1번 테이블로 걸어가 같은 번호를 다시 넣는다.** B의 태블릿은
    //    아무도 건드리지 않는데, 그 화면의 빈 자리에 A가 나타난다.
    mark('장면 5 — 1번 테이블에 합석한다');
    await sitDown(moverPage, manifest.store.id, table1.id, MOVED_SEATS.p3, mover.otp);

    // **칩이 좌석보다 오래 산다.** 옮겨 앉아도 스택이 그대로다.
    total += 5_000;
    const moved = await tableState(request, table1.id, ownerToken);
    expectChips(moved, '옮겨 앉은 뒤', total);
    expect(`옮겨 온 사람 ${moved.players[MOVED_SEATS.p3]!.nickname}`).toBe(
      `옮겨 온 사람 ${mover.nickname}`,
    );
    // B(딥스택)의 화면에서 그 자리가 찼는지 본다. 아무도 B의 태블릿을
    // 건드리지 않았다 — 소켓으로 온 것이다.
    await expect(p2Page.getByTestId(`seat-${MOVED_SEATS.p3}`)).toContainText(mover.nickname);
    await shoot(moverPage, 'seat-moved');
    await shoot(p2Page, 'seat-joined');
    await linger(p2Page, 2_500);

    // 남은 둘은 배경이다. 태블릿을 더 띄우는 대신 API로 옮긴다.
    for (const [seatIndex, who] of [
      [MOVED_SEATS.p4, mover2],
      [MOVED_SEATS.p5, mover3],
    ] as const) {
      await seat(request, manifest.tournament.id, {
        tableId: table1.id,
        seatIndex,
        otp: who.otp,
      });
      total += 5_000;
    }
    expectChips(await tableState(request, table1.id, ownerToken), '셋 다 옮긴 뒤', total);

    // 5. 빈 테이블을 닫는다. 사람이 남아 있으면 버튼이 잠긴다(`ConsoleClient`가
    //    `occupants.length > 0`으로 막는다) — 그 잠금이 풀린 것 자체가 2번
    //    테이블이 비었다는 증거다.
    mark('장면 5 — 빈 테이블을 닫는다');
    await console_.reload();
    await press(console_, console_.getByTestId(`console-pick-table-${table2.id}`));
    await linger(console_, 1_500);
    await press(console_, console_.getByRole('button', { name: /테이블 닫기/ }), 700, 1_500);
    await expect(console_.getByTestId(`console-pick-table-${table2.id}`)).toBeHidden({
      timeout: 15_000,
    });
    await linger(console_, 3_000);

    mark('끝');
  });
});
