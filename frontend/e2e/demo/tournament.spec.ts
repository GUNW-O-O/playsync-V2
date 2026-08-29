import { Page } from '@playwright/test';
import { chipsOnTable, dealerBearerToken, login, seat, tableState } from '../fixtures/backstage';
import { playerAt, tableByOrder } from '../fixtures/manifest';
import {
  PHASE,
  clickAction,
  driveToShowdown,
  enterDealer,
  expectChips,
  linger,
  openDealerTablet,
  openWithToken,
  press,
  pressUntilEffective,
  shoot,
  sitDown,
  typeOtp,
  watchSocket,
} from '../fixtures/screen';
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
    await openDealerTablet(dealer, manifest.store.id, manifest.tournament.id);

    // 0. 옆자리에는 이미 사람이 앉아 있다. 배경이라 카메라가 폰으로 가기
    //    전에 끝내 둔다 — 폰이 번호를 보여준 뒤에 이걸 하면 "번호를 받았는데
    //    한참 딴짓하다 자리로 간다"가 된다.
    await sitDown(p1Page, manifest.store.id, manifest.tournament.id, table1.id, SEATS.p1, mid.otp);

    // mid는 이 시점부터 table1에 실제로 앉아 있다. 딜러가 아직 안 들어와
    // 딜러 토큰이 없는 장면 1의 유일한 `tableState` 조회(아래 `seated`)가
    // 이 값을 쓴다 — 소유자가 아니라 **그 테이블에 실제로 앉은 사람**의
    // 진짜 토큰이라 T66의 판정을 그대로 통과한다. 장면 4에서 mid가 다시
    // 로그인해 받는 `midToken`(폰 화면용)과는 용도가 달라 이름을 나눈다.
    const midSeatToken = await login(request, mid.nickname, manifest.password);

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
    await shoot(phone, '29-phone-entry-otp');
    // 폰이 보여준 모양(자릿수만큼 칸)과 태블릿이 요구하는 모양(키패드)이
    // 같다는 것이 이 장면의 그림이다. **곧바로 자리로 간다** — 사이에 다른
    // 일을 끼우면 번호를 들고 걸어가는 흐름이 끊긴다.
    await linger(phone, 1_800);

    // 4. **폰의 번호를 자리의 태블릿에 넣는다.** 장면 1의 한가운데다.
    mark('장면 1 — 태블릿에 그 번호를 넣는다');
    await sitDown(
      heroPage,
      manifest.store.id,
      manifest.tournament.id,
      table1.id,
      SEATS.hero,
      heroOtp,
      'seat-waiting',
    );
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
    await shoot(console_, '27-console-layout');
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
    await shoot(console_, '30-console-dealer-otp');
    await linger(console_, 2_500);

    // =====================================================================
    // 장면 2 — 대회가 열리고 한 판이 끝난다
    // =====================================================================
    mark('장면 2 — 자리가 찬다');

    const p2Page = await stage('tablet', 'seat-p2');
    await sitDown(p2Page, manifest.store.id, manifest.tournament.id, table1.id, SEATS.p2, deep.otp);

    // 2번 테이블. **옮겨 갈 사람(A)에게는 자기 태블릿을 준다** — 장면 5가
    // "A의 자리가 바뀐다"를 보여주는 장면이라, A가 어느 화면에서 나와 어느
    // 화면으로 들어가는지가 보여야 한다. 나머지 둘은 **배경이라** API로
    // 앉힌다 — 녹화 컨텍스트는 하나가 비싸고, 배경은 그릴 값이 없다.
    const moverPage = await stage('tablet', 'seat-mover');
    await sitDown(moverPage, manifest.store.id, manifest.tournament.id, table2.id, TABLE2_SEATS.p3, mover.otp);
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

    const seated = await tableState(request, table1.id, midSeatToken);
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
    await enterDealer(dealer, manifest.store.id, manifest.tournament.id, table1.id, shownDealerOtp);
    await expect(dealer.getByTestId(`seat-${SEATS.hero}`)).toBeVisible();
    await linger(dealer, 1_200);

    // 이 시점부터 딜러가 table1의 진짜 딜러다 — 이후 모든 `tableState` 조회는
    // 이 토큰을 쓴다. 딜러 판정(`assertTableAccess`)은 좌석 점유와 무관하게
    // 토큰의 tableId만 대조하므로, 장면 4에서 누가 탈락해 좌석에서 빠져도
    // (mid의 토큰과 달리) 계속 유효하다.
    const tableToken = await dealerBearerToken(dealer);

    // **아직 대회가 열리지 않았다.** 버튼은 눌리지만 서버가 거절하고, 그
    // 사실이 딜러 화면에 모달로 남는다 — 조용히 사라지지 않는 것이 요점이다.
    // (버튼 자체를 잠그려면 딜러 화면이 대회 상태를 실시간으로 알아야 하는데,
    // 스냅샷에 그 정보가 없다.)
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
    await shoot(board, '28-scoreboard-layout');
    // 전광판 폴링이 1초라 여기서 더 기다릴 것이 없다.
    await expect(
      dealer
        .getByTestId(`seat-${SEATS.hero}-button`)
        .or(dealer.getByTestId(`seat-${SEATS.p1}-button`))
        .or(dealer.getByTestId(`seat-${SEATS.p2}-button`)),
    ).toBeVisible({ timeout: 20_000 });
    await linger(dealer, 2_500);

    expectChips(await tableState(request, table1.id, tableToken), '대회 시작 후', total);

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
      async () => (await tableState(request, table1.id, tableToken)).phase !== PHASE.WAITING,
    );

    const reached = await driveToShowdown({
      request,
      tableId: table1.id,
      token: tableToken,
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
    const showdown = await tableState(request, table1.id, tableToken);
    const warmupWinnerId = showdown.players[SEATS.p2]!.id;

    await press(dealer, dealer.getByRole('button', { name: '승자 결정' }));
    await press(dealer, dealer.getByTestId(`winner-pick-${warmupWinnerId}`));
    // 배분도 WS로 나간다. 소켓이 끊겨 있으면 오버레이만 닫히고 팟은 그대로다.
    await pressUntilEffective(
      dealer,
      '배분',
      async () => (await tableState(request, table1.id, tableToken)).phase === PHASE.WAITING,
      3,
    );

    const after = await tableState(request, table1.id, tableToken);
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
      async () => (await tableState(request, table1.id, tableToken)).phase !== PHASE.WAITING,
    );

    // **상한은 mid의 전 재산이다.** deep이 그보다 더 밀면 아무도 콜하지 못해
    // 환급으로 되돌아오고, 그러면 층이 갈리지 않는다(`allin-sidepot` 2번의
    // 같은 계산).
    const opened = await tableState(request, table1.id, tableToken);
    const midTotal = opened.players[SEATS.p1]!.stack + opened.players[SEATS.p1]!.bet;

    await driveToShowdown({
      request,
      tableId: table1.id,
      token: tableToken,
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
        async () => (await tableState(request, table1.id, tableToken)).phase,
        { timeout: 30_000 },
      )
      .toBe(PHASE.SHOWDOWN);

    const layered = await tableState(request, table1.id, tableToken);
    expectChips(layered, '올인 쇼다운', total);
    // **사이드팟 합 == 팟.** 갈라놓고 어긋나면 지급에서 증발한다.
    expect(`층 ${layered.sidePots.length}`).toBe('층 2');
    expect(`층 합 ${layered.sidePots.reduce((s, p) => s + p.amount, 0)}`).toBe(`층 합 ${layered.pot}`);
    // 딜러 화면에도 층이 그대로 보인다(`Felt.tsx`). 스틸 `dealer-winner.png`가
    // 이 순간이다.
    await expect(dealer.getByTestId('side-pot-1')).toBeVisible();
    await shoot(dealer, '08-dealer-view-of-table');
    await shoot(heroPage, '07-seat-view-of-table');
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
    await shoot(dealer, '10-unnamed-pot-refused');
    await linger(dealer, 3_500);
    // 딜러가 읽고 지운다. 모달이라 지우기 전까지는 다음 조작이 막힌다.
    await press(dealer, dealer.getByRole('button', { name: '확인' }));

    // 거부는 아무것도 건드리지 않는다. 딜러가 다시 찍을 수 있어야 한다.
    const refused = await tableState(request, table1.id, tableToken);
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
    await shoot(dealer, '09-winner-pot-layers');
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
    await shoot(p1Page, '25-rebuy-overlay');
    // 오래 끌지 않는다. 15초 마감이 도는 것을 보여주는 화면이지 기다리는
    // 화면이 아니고, 답은 이미 정해져 있다(거절 → 탈락).
    await linger(p1Page, 1_000);
    await press(p1Page, p1Page.getByRole('button', { name: '거절' }), 300, 500);

    // 거절은 탈락이다. 태블릿은 순위를 그리지 않고 **다음 사람의 자리**로
    // 돌아간다 — 순위·상금은 사람에게 붙는 정보라 폰이 들고 있다.
    //
    // **덮개가 사유를 적는다.** 여기는 리바인을 거절한 자리라 탈락이고,
    // 장면 5의 좌석 해제(아래)는 같은 덮개가 「자리를 이동해 주세요」를
    // 적는다. 두 단언이 서로 다른 문구를 요구하는 것이 그 판정의 증거다 —
    // 한 문구로 덮던 시절에는 촬영이 둘을 구분하지 못했다.
    await expect(p1Page.getByText('칩이 0이 되어 대회에서 나왔습니다')).toBeVisible();
    await linger(p1Page, 2_500);

    await expect
      .poll(
        async () => (await tableState(request, table1.id, tableToken)).phase,
        { timeout: 30_000 },
      )
      .toBe(PHASE.WAITING);

    const settled = await tableState(request, table1.id, tableToken);
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
    await shoot(phone, '26-phone-shows-rank');
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
    //    오버레이지만 탈락이 아니다 — 칩은 그대로고, 문구가 그렇게 적힌다.
    mark('장면 5 — 좌석을 해제한다');
    await press(console_, console_.getByRole('button', { name: /고른 자리 해제/ }), 700, 1_200);
    await expect(console_.getByTestId(`console-seat-${TABLE2_SEATS.p3}`)).not.toContainText(
      mover.nickname,
    );
    // 칩을 든 채 자리만 잃은 것이라 덮개가 탈락이 아니라 **이동**을 적는다.
    await expect(moverPage.getByText('자리를 이동해 주세요')).toBeVisible({ timeout: 20_000 });
    await linger(moverPage, 1_800);
    await press(moverPage, moverPage.getByRole('button', { name: '지금 돌아가기' }));
    await moverPage.waitForURL(/\/table\?store=/);

    // 5. **A가 1번 테이블로 걸어가 같은 번호를 다시 넣는다.** B의 태블릿은
    //    아무도 건드리지 않는데, 그 화면의 빈 자리에 A가 나타난다.
    mark('장면 5 — 1번 테이블에 합석한다');
    await sitDown(moverPage, manifest.store.id, manifest.tournament.id, table1.id, MOVED_SEATS.p3, mover.otp);

    // **칩이 좌석보다 오래 산다.** 옮겨 앉아도 스택이 그대로다.
    total += 5_000;
    const moved = await tableState(request, table1.id, tableToken);
    expectChips(moved, '옮겨 앉은 뒤', total);
    expect(`옮겨 온 사람 ${moved.players[MOVED_SEATS.p3]!.nickname}`).toBe(
      `옮겨 온 사람 ${mover.nickname}`,
    );
    // B(딥스택)의 화면에서 그 자리가 찼는지 본다. 아무도 B의 태블릿을
    // 건드리지 않았다 — 소켓으로 온 것이다.
    await expect(p2Page.getByTestId(`seat-${MOVED_SEATS.p3}`)).toContainText(mover.nickname);
    await shoot(moverPage, '15-stack-survives-move');
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
    expectChips(await tableState(request, table1.id, tableToken), '셋 다 옮긴 뒤', total);

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
