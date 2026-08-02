import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { BACKEND_URL, bearer, login } from './fixtures/backstage';
import { playerByNickname, tableByOrder } from './fixtures/manifest';
import { expect, slug, test } from './fixtures/surfaces';

/**
 * 하네스 자체를 검사한다. **앱의 화면을 검사하지 않는다** — 화면은 아직
 * 없거나(B7) 다시 그려질 것이고, 그것을 여기서 단언하면 촬영 토대가 화면
 * 한 번 고칠 때마다 빨개진다.
 *
 * 여기서 증명하는 것은 셋이고 서로 다른 고리다.
 *
 *   1. 시드가 남긴 좌표를 **백엔드가 같은 대회로 안다** — 매니페스트와 DB가
 *      어긋나면(시드를 다시 돌리고 파일만 남았다든지) 여기서 걸린다. 공개
 *      대시보드로는 볼 수 없다. 시작 전에는 Redis 스냅샷이 없어 `null`이라
 *      없는 대회와 구별되지 않는다.
 *   2. 브라우저가 프론트에 닿고 **영상이 이름 붙은 파일로 남는다** — 개발 서버
 *      기동, 뷰포트, 뒷정리의 `saveAs`까지가 한 줄에 걸린다.
 *   3. 매니페스트에 없는 것을 고르면 **거기서 멈춘다** — 촬영 중 오타가 조용히
 *      `undefined`로 흘러가지 않는다.
 *
 * 하나가 통과하고 둘이 실패하는 조합이 각각 실제로 다른 것을 가리킨다.
 */

const RECORDINGS_ROOT = resolve(__dirname, 'recordings');
const VIDEO_TEST_TITLE = '브라우저가 프론트에 닿고 영상이 남는다';

test('시드 매니페스트의 대회를 백엔드가 안다', async ({ manifest, request }) => {
  // 상점 계정으로 들어간다. 시드가 만든 비밀번호가 실제로 통하는지까지 여기서
  // 걸린다 — 촬영의 첫 장면이 이 로그인이다.
  const token = await login(request, 'owner', manifest.password);

  const res = await request.get(`${BACKEND_URL}/store/sessions/${manifest.store.id}`, {
    headers: bearer(token),
  });
  expect(`응답 ${res.status()}`).toBe('응답 200');

  const tournaments = (await res.json()) as { id: string; name: string; status: string }[];
  const seeded = tournaments.find((t) => t.id === manifest.tournament.id);

  // 파일에 적힌 id를 DB가 모르면(시드를 다시 돌리고 파일만 남았다든지) 여기서
  // 끝난다. 목록이 비지 않았다는 것만으로는 같은 대회라는 증거가 못 된다.
  expect(`대회 ${seeded?.name}`).toBe(`대회 ${manifest.tournament.name}`);
  // 무대는 **깔려만 있다.** 시작은 상점 콘솔에서 사람이 누르는 장면이다.
  expect(`상태 ${seeded?.status}`).toBe('상태 PENDING');
});

test(VIDEO_TEST_TITLE, async ({ stage }) => {
  const phone = await stage('phone', 'phone');

  await phone.goto('/');
  // 랜딩 페이지를 두지 않는 것이 이 앱의 방식이다(`src/app/page.tsx`).
  // 미들웨어가 `?next=`를 붙이므로 glob이 아니라 정규식으로 본다.
  await phone.waitForURL(/\/login/);

  expect(`가로 ${phone.viewportSize()?.width}`).toBe('가로 390');
});

test('매니페스트에 없는 것을 고르면 거기서 멈춘다', async ({ manifest }) => {
  expect(() => tableByOrder(manifest, 99)).toThrow(/99번 테이블이 시드에 없다/);
  expect(() => playerByNickname(manifest, 'nobody')).toThrow(/nobody이 시드에 없다/);

  // 결제하지 않은 계정은 참가자 목록에 없다. 폰 흐름을 처음부터 찍기 위한
  // 자리라서다(`prisma/seed.ts`).
  expect(() => playerByNickname(manifest, manifest.unpaidPlayer)).toThrow();
});

/**
 * 영상은 컨텍스트가 닫힌 뒤에 떨어지므로 테스트 안에서는 볼 수 없다.
 * 픽스처 뒷정리가 끝난 뒤인 여기서 확인한다.
 */
test.afterAll(() => {
  const video = join(RECORDINGS_ROOT, slug(VIDEO_TEST_TITLE), 'phone.webm');
  if (!existsSync(video)) {
    throw new Error(`영상이 남지 않았다: ${video}`);
  }
});
