import { Page } from '@playwright/test';
import { login } from './fixtures/backstage';
import { playerByNickname } from './fixtures/manifest';
import { expect, test } from './fixtures/surfaces';

/**
 * 상점 콘솔 · 전광판 · 참가자 폰. 셋 다 **읽기만** 한다.
 *
 * 쓰기(대회 시작·딜러 OTP 재발급)를 여기서 하지 않는 이유는 무대가 하나이기
 * 때문이다. 이 파일이 대회를 시작하면 `harness.spec.ts`의 "무대는 아직
 * PENDING" 단언이 무너지고, OTP를 재발급하면 `dealer.spec.ts`가 매니페스트의
 * 평문 OTP로 못 들어간다. 스펙 파일은 알파벳 순으로 도므로
 * (console → dealer → harness → terminal) 여기가 제일 앞이다.
 *
 * 잡는 것은 목이 못 잡는 것 — 봉투 모양, 키 이름, 시작 전 대시보드가 빈
 * 본문 200이라는 사실이다.
 */

/** 상점 콘솔은 `STORE_ADMIN` 쿠키로 선다. 로그인 자체는 카메라 밖이다. */
async function signInAsOwner(page: Page, token: string) {
  await page.context().addCookies([
    { name: 'accessToken', value: token, domain: 'localhost', path: '/' },
  ]);
}

/**
 * 폰은 사람이 직접 로그인한다 — 서버 액션이 백엔드로 바로 나가는 유일한
 * 인증 경로(`auth/action.ts`)를 실제로 한 번 지나기 위해서다.
 *
 * 완료의 신호는 **쿠키**다. 예전에는 성공 시 `redirect('/')`가 다시
 * `/login`으로 돌아와서(`src/app/page.tsx`) 주소가 그대로였고, URL로
 * 기다리면 즉시 통과해 쿠키가 심기기 전에 다음 화면을 여는 경합이 됐다.
 * 지금은 USER가 `/me`로 간다(`auth/action.ts`의 `landingPath`). 그래도
 * 쿠키로 기다리는 것은 그대로 둔다 — 로그인의 결과물은 이동이 아니라
 * 쿠키이고, 착지 지점은 역할과 `next`에 따라 갈린다.
 */
async function signInOnPhone(page: Page, nickname: string, password: string) {
  await page.goto('/login');
  // placeholder가 아니라 label로 찾는다. 입력을 시작하면 사라지는 값을
  // 셀렉터로 쓰면, 화면이 label을 갖췄는지 여부를 아무도 판정하지 않는다.
  await page.getByLabel('닉네임').fill(nickname);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();

  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === 'accessToken'))
    .toBe(true);
}

test('상점 콘솔이 시드된 대회와 테이블 둘을 보여준다', async ({ stage, manifest, request }) => {
  const token = await login(request, 'owner', manifest.password);
  const console_ = await stage('console', 'console-detail');
  await signInAsOwner(console_, token);

  await console_.goto(`/stores/${manifest.store.id}/tournaments/${manifest.tournament.id}`);

  // `GET /tournaments/:id`는 `{ tournament, seatStatus }` 봉투다. 봉투를
  // 안 벗기면 여기서 "대회를 찾을 수 없습니다"가 뜬다 — 실제로 한 번 그랬다.
  await expect(console_.getByText(manifest.tournament.name)).toBeVisible();
  await expect(console_.getByText(manifest.tournament.entryFee.toLocaleString())).toBeVisible();

  // 테이블 번호는 `GET /dealer/:tournamentId`의 `tables[].tableOrder`다.
  for (const table of manifest.tables) {
    await expect(console_.getByTestId(`console-pick-table-${table.id}`)).toBeVisible();
  }

  // 좌석 조회(`GET /store/sessions/:id/seats`)가 실패하면 `ConsoleClient`가
  // `role="alert"` 배너를 띄운다(STORE_ADMIN 전용 가드 — 쿠키 토큰이
  // 안 실리거나 거부되면 뜬다). 배너가 없다는 것 자체가 그 조회가 200이었다는
  // 뜻이다 — 지금까지는 아무 스펙도 이걸 판정하지 않았다.
  //
  // `main` 안으로 좁힌다 — 개발 서버는 Next.js Dev Tools 오버레이가 페이지
  // 바깥에 자기 `role="alert"` 라이브 리전을 항상 그려서, 좁히지 않으면
  // 우리 배너가 없어도 그 빈 리전과 매치돼 개수가 흔들린다.
  await expect(console_.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('시작 전 전광판은 대기 중을 그린다', async ({ stage, manifest, request }) => {
  const token = await login(request, 'owner', manifest.password);
  const board = await stage('scoreboard', 'scoreboard-waiting');
  await signInAsOwner(board, token);

  await board.goto(
    `/stores/${manifest.store.id}/tournaments/${manifest.tournament.id}/display`,
  );

  // 시작 전에는 Redis 스냅샷이 없어 `GET /playsync/dashboard/:id`가 **빈 본문
  // 200**을 준다. 없는 대회와 구별되지 않으므로 에러가 아니라 대기 중이다.
  // 이건 목으로는 확인할 수 없다 — 목은 항상 무언가를 돌려주기 때문이다.
  await expect(board.getByText('대기 중')).toBeVisible();
});

test('참가자 폰이 시드된 참가 OTP를 조회 뒤에 보여준다', async ({ stage, manifest }) => {
  const player = playerByNickname(manifest, 'player1');
  const phone = await stage('phone', 'phone-my-otp');

  await signInOnPhone(phone, player.nickname, manifest.password);
  await phone.goto('/me');

  await expect(phone.getByText(new RegExp(manifest.tournament.name))).toBeVisible();

  // 조회 전에는 값이 DOM에 없다. 홀은 사람이 붙어 앉는 곳이다.
  await expect(phone.getByTestId('player-otp')).toHaveCount(0);

  await phone.getByRole('button', { name: '참가 OTP 조회' }).click();

  // OTP는 `GET /user/me/participations`의 `playerOtp`다. 대회가 끝나면
  // 서버가 null로 지우지만 무대는 PENDING이라 평문 그대로 온다.
  //
  // 자리마다 칸을 나눠 그리므로 값이 한 덩어리가 아니다 —
  // `getByText(otp)`로는 잡히지 않는다. 태블릿 키패드가 요구하는 모양과
  // 같은 모양으로 보여주는 것이 이 화면의 요점이다.
  await expect(phone.getByTestId('player-otp')).toHaveText(player.otp);
});

/**
 * 대회 찾기는 **두 걸음**이다 — 상점을 고르고 그 상점의 대회를 고른다.
 *
 * 여기서 잡는 것은 목이 못 잡는 봉투 차이다. `GET /tournaments/:id`는
 * `{ tournament, seatStatus }` 봉투인데 `GET /tournaments/stores/:storeId`는
 * **봉투가 아니라 배열 그대로**다(`getStoreAvailableSessions`). 목을 쓰면
 * 둘을 같은 모양으로 지어내기 쉽고, 그러면 어느 쪽이 사실인지 화면이
 * 판정하지 못한다.
 */
test('상점을 검색해 그 상점의 대회로 걸어 들어간다', async ({ stage, manifest }) => {
  const player = playerByNickname(manifest, 'player1');
  const phone = await stage('phone', 'phone-find-tournament');

  await signInOnPhone(phone, player.nickname, manifest.password);
  await phone.goto('/tournaments');

  // 검색은 `GET /tournaments/stores?id=<이름>`이고 서버가 하는 일은
  // 이름 contains다. 이름 일부만 넣어도 걸리는지까지 본다.
  await phone.getByLabel('상점 이름').fill(manifest.store.name.slice(0, 2));
  await phone.getByRole('button', { name: '검색' }).click();

  await phone.getByTestId(`pick-store-${manifest.store.id}`).click();

  // 상점 이름이 제목으로 선다. URL에 실어 나르지 않고 다시 읽은 값이다.
  await expect(phone.getByRole('heading', { name: manifest.store.name })).toBeVisible();

  // 대회 카드는 배열의 행 하나다. 참가비가 그대로 떠야 봉투를 잘못 벗기지
  // 않았다는 뜻이다.
  const card = phone.getByTestId(`pick-tournament-${manifest.tournament.id}`);
  await expect(card).toContainText(manifest.tournament.name);
  await expect(card).toContainText(manifest.tournament.entryFee.toLocaleString());

  await card.click();
  await phone.waitForURL(`**/tournaments/${manifest.tournament.id}`);
});

test('참가자 폰의 대회 상세가 백엔드의 참가비와 블라인드를 그대로 보여준다', async ({
  stage,
  manifest,
}) => {
  const player = playerByNickname(manifest, 'player1');
  const phone = await stage('phone', 'phone-tournament');

  await signInOnPhone(phone, player.nickname, manifest.password);
  await phone.goto(`/tournaments/${manifest.tournament.id}`);

  await expect(phone.getByText(manifest.tournament.name)).toBeVisible();
  await expect(
    phone.getByRole('button', { name: new RegExp(`${manifest.tournament.entryFee.toLocaleString()}`) }),
  ).toBeVisible();

  // 블라인드 표의 첫 줄은 `blindStructure.structure[0]`이고 bb는 서버에
  // 없다 — `sb * 2`로 파생한다(`packages/contract/src/dashboard.ts`).
  const firstLevel = manifest.tournament.blindStructure[0];
  await expect(
    phone.getByText(`${firstLevel.sb.toLocaleString()} / ${(firstLevel.sb * 2).toLocaleString()}`),
  ).toBeVisible();
});

/**
 * 역할 불일치 404(`middleware.ts:37`)가 최종 응답에서도 실제로 404인지.
 *
 * `middleware.test.ts`는 `NextResponse.rewrite(..., { status: 404 })`가
 * 반환하는 객체의 `.status`만 본다 — Next.js가 그 응답을 실제로 서빙할 때도
 * 404를 내는지는 목이 못 잡는다(이 파일 상단 주석과 같은 이유). USER 계정으로
 * 상점 콘솔 URL을 직접 열어 `page.goto`의 실제 HTTP 상태를 본다.
 */
test('참가자 계정으로 상점 콘솔 대회 상세를 열면 404다', async ({ stage, manifest }) => {
  const player = manifest.players[0];
  const phone = await stage('phone', 'phone-console-forbidden');

  await signInOnPhone(phone, player.nickname, manifest.password);
  const response = await phone.goto(
    `/stores/${manifest.store.id}/tournaments/${manifest.tournament.id}`,
  );

  expect(response?.status()).toBe(404);
});
