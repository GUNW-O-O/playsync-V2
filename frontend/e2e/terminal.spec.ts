import { playerAt, tableByOrder } from './fixtures/manifest';
import { expect, test } from './fixtures/surfaces';

/**
 * 좌석 태블릿. **진짜 백엔드가 판정한다.**
 *
 * 단위 테스트의 목이 못 잡는 것을 여기서 잡는다 — 봉투 모양(`{ tournament,
 * seatStatus }`), 키 이름(`seatStatus`·`tableOrder`), 상태 전이(입장하면
 * Redis 좌석 비트가 올라간다). 화면의 색이나 배치는 단언하지 않는다.
 *
 * 시드가 깔아 둔 무대는 **대회가 PENDING이고 아무도 앉아 있지 않은** 상태다.
 * 여기서 사람을 하나 앉히므로, 파일 이름이 알파벳 순으로 마지막인 것이
 * 의도다 — `harness.spec.ts`가 "대회는 아직 PENDING"을 단언한다(입장은 대회
 * 상태를 바꾸지 않으므로 그 단언은 그대로 선다).
 */
test('좌석 대기 화면이 시드된 대회와 테이블을 그대로 보여준다', async ({ stage, manifest }) => {
  const tablet = await stage('tablet', 'seat-waiting');

  await tablet.goto(`/table?store=${manifest.store.id}`);

  // 대회 이름은 `GET /tournaments/stores/:storeId`가 준 값이다.
  await expect(tablet.getByText(manifest.tournament.name).first()).toBeVisible();

  // 테이블 둘은 `GET /dealer/:tournamentId`의 `tables`에서 온다. id가 키다 —
  // 목이었다면 아무 문자열이나 통했다.
  for (const table of manifest.tables) {
    await expect(tablet.getByTestId(`pick-table-${table.id}`)).toBeVisible();
  }

  // 아무도 앉지 않은 무대라 아홉 자리가 전부 눌린다. 하나라도 점선이면
  // 시드가 남긴 상태와 Redis 비트맵이 어긋난 것이다.
  for (let i = 0; i < 9; i++) {
    await expect(tablet.getByTestId(`pick-seat-${i}`)).toBeEnabled();
  }
});

test('참가 OTP를 넣으면 좌석이 확정되고 그 자리가 점선으로 잠긴다', async ({ stage, manifest }) => {
  const table = tableByOrder(manifest, 1);
  const player = playerAt(manifest, 0);
  const SEAT_INDEX = 3;

  const tablet = await stage('tablet', 'seat-enter');
  await tablet.goto(`/table?store=${manifest.store.id}`);

  await tablet.getByTestId(`pick-table-${table.id}`).click();
  await tablet.getByTestId(`pick-seat-${SEAT_INDEX}`).click();
  for (const digit of player.otp) {
    await tablet.getByRole('button', { name: digit, exact: true }).click();
  }
  await tablet.getByRole('button', { name: /참가/ }).click();

  // 성공하면 좌석 토큰이 쿠키로 심기고 게임 화면으로 넘어간다.
  await tablet.waitForURL(`**/table/${table.id}`);
  // 자리에 닉네임과 시작 스택이 떠 있다. 둘 다 백엔드가 만든 스냅샷에서
  // 온 값이다 — 목이었다면 `players[3]`에 무엇을 넣든 통했다.
  const mySeat = tablet.getByTestId(`seat-${SEAT_INDEX}`);
  await expect(mySeat).toContainText(player.nickname);
  await expect(mySeat).toContainText(manifest.tournament.startStack.toLocaleString());

  // 대기 화면으로 돌아오면 그 자리는 잠겨 있다. 판정하는 것은 목이 아니라
  // Redis 좌석 비트맵이다(`GET /tournaments/:id/seats`).
  const second = await stage('tablet', 'seat-waiting-after');
  await second.goto(`/table?store=${manifest.store.id}`);
  await second.getByTestId(`pick-table-${table.id}`).click();
  await expect(second.getByTestId(`pick-seat-${SEAT_INDEX}`)).toBeDisabled();
});
