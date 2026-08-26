import { expect, Page } from '@playwright/test';
import { join, resolve } from 'path';
import { chipsOnTable, tableState, type DemoTableState } from './backstage';

/**
 * **화면을 사람처럼 다루는 손.** 촬영 스펙 둘이 같이 쓴다.
 *
 * `backstage.ts`가 「카메라에 잡히지 않는 것」이라면 여기는 그 반대다 — 커서를
 * 옮기고, 한 박자 쉬고, 누르고, 결과를 볼 시간을 준다. 그 리듬 자체가 촬영의
 * 산출물이라 판정용 e2e와 같은 코드를 쓸 수 없다.
 *
 * 처음에는 `demo/tournament.spec.ts` 안에 있었다. 정산 촬영
 * (`demo/settlement.spec.ts`)이 같은 손을 필요로 하면서 밖으로 나왔다 —
 * 두 벌이 되면 어긋나고, **어긋난 것을 잡아 주는 장치가 없다.** 여기서 배운
 * 것(소켓이 붙기 전의 클릭은 조용히 사라진다 · 누르는 것이 프레임에 남아야
 * 한다)은 한쪽에서만 지켜지면 뜻이 없다.
 */

/**
 * 시드가 만드는 참가 OTP 길이만큼 키패드를 누른다.
 *
 * 자리마다 조금씩 쉰다. 여덟 자리를 순식간에 채우면 영상에서는 번호가 그냥
 * "나타난다" — 폰이 보여준 번호가 이 키패드로 들어가는 것이 장면 1의 전부다.
 */
export async function typeOtp(page: Page, otp: string) {
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
export async function press(
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
export async function sitDown(
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
  // 좌석 액션도 소켓이 붙기 전에 누르면 조용히 사라진다. 자리에 앉는 이
  // 지점이 그 소켓이 열리는 유일한 자리라, 여기서 한 번 기다려 둔다.
  const connected = watchSocket(page);
  await press(page, page.getByRole('button', { name: /참가/ }));
  await page.waitForURL(`**/table/${tableId}`);
  await connected;
  await linger(page, 1_200);
}

/**
 * 딜러 태블릿을 켠다. 딜러가 오기 전에도 이 기기는 테이블 고르는 화면을
 * 띄우고 있다 — 좌석 태블릿이 대기 화면을 띄우고 있는 것과 같다.
 */
export async function openDealerTablet(page: Page, storeId: string) {
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
export async function enterDealer(page: Page, storeId: string, tableId: string, dealerOtp: string) {
  await page.goto(`/dealer?store=${storeId}`);
  await press(page, page.getByTestId(`pick-table-${tableId}`));
  await typeOtp(page, dealerOtp);
  // 소켓은 딜러 화면에 들어간 뒤에 열린다. 그 화면으로 넘어가는 클릭보다
  // 먼저 걸어 두지 않으면 첫 프레임을 놓친다.
  const connected = watchSocket(page);
  await press(page, page.getByRole('button', { name: /인증/ }));
  await page.waitForURL(`**/dealer/table/${tableId}`);
  await connected;
}

/**
 * **소켓이 붙을 때까지 기다린다.** 누르기 전에 하는 일이다.
 *
 * 딜러 화면도 좌석 화면도 SSR 스냅샷으로 펠트를 먼저 그리고 WebSocket은 그
 * 뒤에 붙는다 — **버튼이 보인다고 소켓이 붙은 것이 아니다.** 그 사이에 누른
 * 것은 `readyState !== OPEN` 가지로 빠져 `console.error` 하나만 남기고
 * 사라진다. 예전에는 그 뒤에 상태가 바뀌기를 기다리다 죽었다(T73).
 *
 * Playwright에는 소켓의 `open` 이벤트가 없다. 대신 **첫 프레임 수신**을 본다 —
 * 게이트웨이는 테이블에 접속한 소켓에게 `renderGame`을 자기에게만 한 번
 * 보내므로(`WsGateway.handleConnection`), 그 프레임이 도착했다는 것은 소켓이
 * 열렸고 그 테이블 세션에 등록까지 됐다는 뜻이다. `readyState === OPEN`보다
 * 강한 신호다.
 *
 * **네비게이션보다 먼저 걸어야 한다.** `waitForEvent`는 이미 지나간 이벤트를
 * 잡지 못한다. 그래서 이 함수는 기다리지 않고 **약속을 돌려주고**, 부르는
 * 쪽이 화면에 들어간 뒤 그것을 기다린다.
 */
export function watchSocket(page: Page) {
  return page
    .waitForEvent('websocket', { timeout: 60_000 })
    .then((ws) => ws.waitForEvent('framereceived', { timeout: 60_000 }));
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
 *
 * **이제 이것은 두 번째 방어선이다.** 첫 번째는 `watchSocket`이 화면에
 * 들어가는 자리에서 소켓이 붙기를 먼저 기다리는 것이고(T73), 그것이 이
 * 루프가 메우던 구멍 자체를 없앤다. 재시도를 남겨 두는 이유는 소켓이 붙은
 * 뒤에도 끊길 수 있어서다 — 실측으로 화면 진입부터 첫 프레임까지 1.3~2.0초가
 * 걸렸다.
 */
export async function pressUntilEffective(
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
 * 단위 설정이라 **녹화 중인 면 전부의 래스터가 통째로 4배**가 된다. 얻는
 * 것은 없다 — 1280×720 PNG가 README 폭(약 900px)에서 뭉개지지 않는다.
 *
 * 여유 메모리가 얼마인지는 **그때 재서 판단한다.** 여기에 숫자를 박아 두면
 * 다른 기계에서 그 값이 거짓이 되고, 거짓인 줄 모르는 채로 판단의 근거가
 * 된다.
 */
export const SHOTS_DIR = resolve(__dirname, '../.shots');

/**
 * 찍는 동안만 가짜 커서를 지운다.
 *
 * 커서는 `position:fixed` DOM 노드라(`cursor.ts`) **마지막으로 움직인
 * 자리에 그대로 남는다.** `press`가 목표 위로 옮겨 놓고 누르므로, 그 직후에
 * 찍으면 점 28px이 **방금 누른 것 위에 얹힌다** — `19-chop-ledger-sums.png`
 * 에서 「ICM 마무리」가 「ICM ●무리」로 찍혔다. `caret: 'hide'`는 텍스트
 * 캐럿만 숨기고 이 노드는 못 건드린다.
 *
 * 영상에서는 커서가 있어야 조작이 읽히므로 **스틸에서만** 지운다. 지우는
 * 구간이 100ms 미만이고 그 자리가 `linger`로 멈춰 있는 데다 움짤이 8~12fps로
 * 내려가므로, 깜빡임이 프레임에 남지 않는다.
 */
async function withoutCursor<T>(page: Page, run: () => Promise<T>) {
  const set = (visibility: string) =>
    page
      .evaluate((v) => {
        const dot = document.getElementById('__demo_cursor__');
        if (dot) dot.style.visibility = v;
      }, visibility)
      // 커서는 촬영 프로젝트에만 꽂힌다(`surfaces.ts`). 회귀에서 부르면
      // 노드가 없을 뿐이고, 그건 실패가 아니다.
      .catch(() => undefined);

  await set('hidden');
  try {
    return await run();
  } finally {
    await set('visible');
  }
}

/**
 * @param focus 이 요소가 프레임 안에 들어오도록 먼저 굴린다.
 *
 * **뷰포트가 화면보다 짧다.** 상점 콘솔은 좌석 도식 · 딜러 OTP · 마무리
 * 카드가 세로로 이어져 720px에 안 들어간다. `toBeVisible()`은 「DOM에 있고
 * 안 숨겨졌다」라 스크롤 밖도 통과하므로, 그것만 믿고 찍으면 **그림이 제
 * 이름을 못 지킨다** — `18-finish-blocked-reasons.png`에 정작 마무리 카드가
 * 없었다.
 */
export async function shoot(
  page: Page,
  name: string,
  focus?: ReturnType<Page['getByRole']>,
) {
  if (focus) {
    await focus.scrollIntoViewIfNeeded();
    // 스크롤은 부드럽게 움직인다. 굴리는 도중에 찍으면 흐른 프레임이 남는다.
    await page.waitForTimeout(600);
  }
  await withoutCursor(page, () =>
    page.screenshot({
      path: join(SHOTS_DIR, `${name}.png`),
      animations: 'disabled',
      caret: 'hide',
    }),
  );
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
export async function linger(page: Page, ms = 1_800) {
  await page.waitForTimeout(ms);
}

/** 토큰을 쿠키로 심고 그 화면을 연다. 로그인 자체는 카메라 밖이다. */
export async function openWithToken(page: Page, token: string, url: string) {
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
export function expectChips(state: DemoTableState, step: string, total: number) {
  expect(`${step} 칩 총량 ${chipsOnTable(state)}`).toBe(`${step} 칩 총량 ${total}`);
}

/** `GamePhase`. 프론트 enum을 e2e가 import하지 않는다 — 값만 쓴다. */
export const PHASE = { WAITING: 0, SHOWDOWN: 5, HAND_END: 6 } as const;

export type Choice =
  | { kind: 'fold' }
  | { kind: 'passive' } // 체크할 수 있으면 체크, 아니면 콜
  | { kind: 'allin' }
  | { kind: 'raise'; amount: number };

/** 좌석 태블릿 하나에서 액션 하나를 누른다. */
export async function clickAction(page: Page, choice: Choice) {
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
export async function driveToShowdown(opts: {
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


/**
 * 딜러 화면에서 핸드를 연다.
 *
 * "눌렀다"가 아니라 **"페이즈가 `WAITING`을 벗어났다"**를 성공으로 삼는다 —
 * 소켓이 붙기 전의 클릭은 `console.error` 하나만 남기고 사라진다.
 */
export async function startHandOnScreen(
  dealer: Page,
  state: () => Promise<DemoTableState>,
) {
  await pressUntilEffective(
    dealer,
    '핸드 시작',
    async () => (await state()).phase !== PHASE.WAITING,
  );
}

/**
 * 딜러 화면에서 승자를 **순위대로** 찍고 배분한다.
 *
 * `groups`는 계약의 `winnerGroups`와 같은 모양이다 — 바깥 배열의 순서가 곧
 * 순위이고, 안쪽이 동점이다. 화면에서는 「다음 순위」가 그 경계다.
 *
 * **전부 찍는다.** 층이 남으면 서버가 한 칩도 움직이기 전에 거부하는데
 * (T15), 그 거부는 상태를 바꾸지 않으므로 화면만 보고는 먹은 줄 안다.
 * 그래서 여기서도 성공 조건이 「배분을 눌렀다」가 아니라
 * **「페이즈가 넘어갔다」**다.
 */
export async function resolveWinnersOnScreen(
  dealer: Page,
  groups: string[][],
  state: () => Promise<DemoTableState>,
) {
  await press(dealer, dealer.getByRole('button', { name: '승자 결정' }));
  for (const [rank, group] of groups.entries()) {
    if (rank > 0) await press(dealer, dealer.getByRole('button', { name: '다음 순위' }));
    for (const userId of group) {
      await press(dealer, dealer.getByTestId(`winner-pick-${userId}`));
    }
  }
  /*
    **찍은 것을 읽을 시간을 준다.**

    이 화면이 프레임 ①의 인과 그 자체다 — 「딜러가 지명하니 사람이 사라진다」.
    그런데 층이 하나인 판은 자리를 **한 번** 누르고 끝이라(T15 이후 순위를
    층 수만큼만 채운다) 모달이 2초를 못 버티고 닫힌다. 4분할 중 한 타일이라
    시선이 다른 곳에 있으면 그대로 놓치고, 남는 그림은 **조작 없이 결과만
    바뀌는** 화면이다.

    실제 딜러도 찍은 자리를 확인하고 누른다. 그 시간이 여기 없으면 촬영이
    사람보다 빠른 것이다.
  */
  await linger(dealer, 1_600);
  await pressUntilEffective(
    dealer,
    '배분',
    async () => (await state()).phase !== PHASE.SHOWDOWN,
    3,
  );
}
