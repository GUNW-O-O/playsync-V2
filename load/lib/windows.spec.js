import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWindowQueue } from './windows.js';

/**
 * 부하 하네스에 붙는 첫 테스트다.
 *
 * 여기까지 온 이유는 T76이다. 12,000명 실측에서 "내 액션 p95 1,061ms"가 나왔는데
 * 같은 시각 서버 lag은 2.34ms였다. 원인은 서버가 아니라 이 짝짓기였고, 로직이
 * `table.js`의 클로저 안에 있어 **실행 요약을 사람이 읽는 것 말고는 검증할 길이
 * 없었다.** 순수 모듈로 빼면서 그 길을 만든다.
 */

const LIVE = 3;

describe('createWindowQueue', () => {
  it('창을 연 시각부터 봉투가 도착한 시각까지가 왕복이다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    assert.equal(q.match(0, 1042, 1020, LIVE).elapsedMs, 42);
  });

  it('`serverTime` 도장으로 왕복을 서버 쪽과 단말 쪽으로 쪼갠다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    const hit = q.match(0, 1042, 1030, LIVE);
    assert.equal(hit.serverMs, 30);
    assert.equal(hit.clientMs, 12);
  });

  it('도장이 없으면 왕복만 낸다 — 쪼갠 값을 지어내지 않는다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    const hit = q.match(0, 1042, undefined, LIVE);
    assert.equal(hit.elapsedMs, 42);
    assert.equal(hit.serverMs, undefined);
    assert.equal(hit.clientMs, undefined);
  });

  it('뺄셈이 음수면 0으로 자른다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    // 도장이 받은 시각보다 뒤다. 시계가 아니라 이벤트 루프가 만든 역전이다.
    const hit = q.match(0, 1010, 1015, LIVE);
    assert.equal(hit.clientMs, 0);
  });

  /**
   * **이 검사가 T76의 결함 절반이다.**
   *
   * 타임아웃 잡이 대신 폴드시키면 아무도 창을 열지 않은 채 renderGame이 나간다.
   * 그것이 열려 있는 창에 붙으면 그 창의 **진짜 응답은 갈 곳을 잃는다** — 표본이
   * 하나 사라지는 것이 아니라, 그때부터 짝이 한 칸씩 밀린다.
   *
   * 두 단언이 서로를 가리지 않게 갈라 뒀다. 도장 가드를 지우면 첫 줄이 아니라
   * **둘째 줄**이 터진다(진짜 응답이 붙을 창이 없어 `null`이 된다).
   */
  it('창이 열리기 전에 서버를 떠난 봉투는 그 창을 소비하지 않는다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    assert.deepEqual(q.match(0, 1010, 900, LIVE), { stale: true });

    const real = q.match(0, 1015, 1005, LIVE);
    assert.equal(real.elapsedMs, 15);
  });

  it('응답이 끝내 안 온 창은 나이 상한에 걸려 버려진다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);
    q.open(2000, 1);

    assert.equal(q.expire(11500), 1);
    assert.equal(q.size, 1);
  });

  /**
   * 고아 창을 안 걷어내면 뒤에 오는 봉투가 그것에 붙어 **다음 사람의 생각
   * 시간**을 왕복으로 기록한다. 실측에서 유휴 서버(lag 0.25ms)의 p95가
   * 11ms에서 2,586ms로 뛴 자리다.
   */
  it('고아 창을 걷어낸 뒤에는 다음 봉투가 자기 창에 붙는다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0); // 서버가 no-op으로 흘린 액션. 응답이 영영 안 온다
    q.open(13000, 1); // 그 다음 사람의 액션

    q.expire(13040);
    assert.equal(q.match(0, 13040, 13020, LIVE).elapsedMs, 40);
  });

  it('살아 있는 소켓이 다 본 창은 앞에서 걷어낸다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    q.match(0, 1010, 1005, LIVE);
    q.match(1, 1011, 1005, LIVE);
    assert.equal(q.size, 1);

    q.match(2, 1012, 1005, LIVE);
    assert.equal(q.size, 0);
  });

  /**
   * 소켓 하나가 죽으면(티켓 만료의 1008, 서버 재시작) 그 창은 영영 안 채워져
   * 큐 앞에 눌러앉는다. 그래서 **살아 있는 소켓으로 센다.**
   */
  it('죽은 소켓을 기다리지 않는다 — 산 것이 다 봤으면 걷어낸다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);

    q.match(0, 1010, 1005, 2);
    q.match(1, 1011, 1005, 2);
    assert.equal(q.size, 0);
  });

  it('소켓마다 자기가 아직 못 본 가장 오래된 창에 기록한다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);
    q.open(1100, 1);

    assert.equal(q.match(0, 1010, 1005, LIVE).actorSocketIdx, 0);
    assert.equal(q.match(0, 1110, 1105, LIVE).actorSocketIdx, 1);
  });

  it('짝지을 창이 없는 봉투는 아무것도 만들지 않는다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });

    assert.equal(q.match(0, 1010, 1005, LIVE), null);
  });

  it('재접속 폭발은 창을 통째로 비운다', () => {
    const q = createWindowQueue({ maxAgeMs: 10000 });
    q.open(1000, 0);
    q.open(1100, 1);

    q.clear();
    assert.equal(q.size, 0);
  });
});
