import { tableByOrder } from './fixtures/manifest';
import { expect, test } from './fixtures/surfaces';

/**
 * 딜러 태블릿. 여기서 잡는 것은 **딜러 OTP 경로가 끝까지 이어지는가**다.
 *
 * 단위 테스트는 서버 액션을 목으로 바꿔 놓고 화면 전환만 본다. 그래서 OTP를
 * bcrypt로 대조하는 것, 성공 응답에서 `accessToken`을 꺼내 `dealerToken`
 * 쿠키로 심는 것, 그 쿠키로 딜러 화면이 서는 것 — 셋 중 무엇이 틀려도
 * 초록이다. 진짜 백엔드가 판정하게 한다.
 *
 * 시드가 준 평문 딜러 OTP는 매니페스트에만 있다. DB에는 해시뿐이다.
 */
test('딜러 대기 화면이 시드된 대회와 테이블 둘을 보여준다', async ({ stage, manifest }) => {
  const tablet = await stage('tablet', 'dealer-waiting');

  await tablet.goto(`/dealer?store=${manifest.store.id}`);

  await expect(tablet.getByText(manifest.tournament.name).first()).toBeVisible();
  for (const table of manifest.tables) {
    await expect(tablet.getByTestId(`pick-table-${table.id}`)).toBeVisible();
  }
});

test('딜러 OTP를 넣으면 그 테이블의 딜러 화면이 선다', async ({ stage, manifest }) => {
  const table = tableByOrder(manifest, 2);
  const tablet = await stage('tablet', 'dealer-enter');

  await tablet.goto(`/dealer?store=${manifest.store.id}`);
  await tablet.getByTestId(`pick-table-${table.id}`).click();
  for (const digit of manifest.dealerOtp) {
    await tablet.getByRole('button', { name: digit, exact: true }).click();
  }
  await tablet.getByRole('button', { name: /인증/ }).click();

  // URL에 테이블 id가 박히는 것이 성공의 신호다. 실패하면 화면에 남아
  // 백엔드 문구를 배너로 띄운다(`DealerWaitingClient`).
  await tablet.waitForURL(`**/dealer/table/${table.id}`);

  // 딜러 방향 펠트가 선다 — 아홉 자리가 다 그려진다. 아직 아무도 앉지
  // 않은 테이블이라 자리는 비어 있는 것이 맞다.
  await expect(tablet.getByTestId('seat-0')).toBeVisible();
  await expect(tablet.getByTestId('seat-8')).toBeVisible();
});
