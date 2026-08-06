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
 * URL로 완료를 기다리지 않는다. 성공 시 `redirect('/')`가 다시 `/login`으로
 * 돌아오므로(`src/app/page.tsx`) 주소가 그대로라 기다림이 즉시 통과해 버리고,
 * 쿠키가 심기기 전에 다음 화면을 여는 경합이 된다. 실제로 이 스펙이 그
 * 경합으로 처음 빨갰다. 완료의 신호는 **쿠키**다.
 */
async function signInOnPhone(page: Page, nickname: string, password: string) {
  await page.goto('/login');
  await page.getByPlaceholder('Nickname').fill(nickname);
  await page.getByPlaceholder('Password').fill(password);
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

test('참가자 폰이 시드된 참가 OTP를 그대로 보여준다', async ({ stage, manifest }) => {
  const player = playerByNickname(manifest, 'player1');
  const phone = await stage('phone', 'phone-my-otp');

  await signInOnPhone(phone, player.nickname, manifest.password);
  await phone.goto('/me');

  // OTP는 `GET /user/me/participations`의 `playerOtp`다. 대회가 끝나면
  // 서버가 null로 지우지만 무대는 PENDING이라 평문 그대로 온다.
  await expect(phone.getByText(player.otp)).toBeVisible();
  await expect(phone.getByText(new RegExp(manifest.tournament.name))).toBeVisible();
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
