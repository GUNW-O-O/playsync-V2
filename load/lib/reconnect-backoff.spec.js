import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MAX_ATTEMPTS,
  FALLBACK_FLOOR_MS,
  nextAttempt,
  retryAfterMs,
  spreadForHerd,
} from './reconnect-backoff.js';

/**
 * 재접속 백오프 정책의 테스트.
 *
 * **바닥과 지터가 어긋나는 입력을 먹인다.** 둘 다 30000이 기본값이라, 30을
 * 실어 주면 "헤더를 읽는다"와 "기본값으로 떨어진다"가 같은 답을 낸다 — 헤더
 * 읽는 코드를 통째로 지워도 초록인 상태다(T29에서 데인 자리와 같다). 그래서
 * 어느 기본값도 아닌 `7`을 쓴다.
 */

describe('retryAfterMs', () => {
  it('헤더의 초를 밀리초로 읽는다', () => {
    // 기본값(30000)도 창(60000)도 아닌 값이라야 "읽었다"가 증명된다.
    assert.equal(retryAfterMs({ headers: { 'Retry-After': '7' } }), 7000);
  });

  it('대소문자에 기대지 않는다', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': '7' } }), 7000);
  });

  it('헤더가 없으면 null이다 — 초를 지어내지 않는다', () => {
    assert.equal(retryAfterMs({ headers: {} }), null);
    assert.equal(retryAfterMs({}), null);
  });

  it('읽을 수 없는 값은 null이다', () => {
    // HTTP 날짜 형식을 일부러 안 읽는다. 이 서버가 안 보내는 모양이라,
    // 반쯤 읽는 것보다 바닥으로 떨어지는 편이 눈에 띈다.
    assert.equal(retryAfterMs({ headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }), null);
    assert.equal(retryAfterMs({ headers: { 'Retry-After': '' } }), null);
    assert.equal(retryAfterMs({ headers: { 'Retry-After': '-1' } }), null);
  });
});

describe('spreadForHerd', () => {
  /**
   * T93이 정해야 하는 숫자다. 1,000대가 분당 600짜리 버킷을 나눠 쓰면
   * 100초에 걸쳐 흩어져야 두 번째 파도가 문에 안 걸린다.
   */
  it('무리를 상한으로 나눠 분 단위로 환산한다', () => {
    assert.equal(spreadForHerd(1000, 600), 100_000);
    assert.equal(spreadForHerd(600, 600), 60_000);
  });

  it('상한 안에 들어가는 무리는 흩을 이유가 없다', () => {
    // 300대면 30초다 — 상한의 절반이라 한 창에 다 들어간다.
    assert.equal(spreadForHerd(300, 600), 30_000);
  });

  it('말이 안 되는 입력은 0이다', () => {
    assert.equal(spreadForHerd(0, 600), 0);
    assert.equal(spreadForHerd(1000, 0), 0);
  });
});

describe('nextAttempt', () => {
  it('통과했으면 다시 두드리지 않는다', () => {
    const r = nextAttempt({ status: 200 }, 0);
    assert.equal(`${r.retry} ${r.reason}`, 'false ok');
  });

  /**
   * **429만 다시 두드린다.** 401·5xx·연결 실패를 재시도에 섞으면 "문에
   * 걸렸다"와 "못 잰다"가 한 숫자로 뭉개진다. k6는 응답을 못 받으면 0을 준다.
   */
  it('429가 아닌 실패는 재시도가 아니다', () => {
    for (const status of [401, 500, 0]) {
      const r = nextAttempt({ status }, 0);
      assert.equal(`${status} ${r.retry} ${r.reason}`, `${status} false not-limited`);
    }
  });

  it('429면 `Retry-After`를 바닥으로 삼는다', () => {
    const r = nextAttempt({ status: 429, headers: { 'Retry-After': '7' } }, 0, {
      spreadMs: 1000,
      rand: () => 0,
    });
    assert.equal(`${r.retry} ${r.waitMs}`, 'true 7000');
  });

  it('`Retry-After`가 없으면 바닥으로 떨어진다', () => {
    const r = nextAttempt({ status: 429, headers: {} }, 0, { spreadMs: 1000, rand: () => 0 });
    assert.equal(r.waitMs, FALLBACK_FLOOR_MS);
  });

  /**
   * **전폭 지터다.** `rand()`가 0이면 바닥 그대로, 1에 가까우면 바닥 + 폭
   * 가까이가 나와야 한다. `바닥 + 폭/2 ± 조금`으로 구현하면 첫 단언이 깨진다 —
   * 그런 구현은 무리를 흩는 게 아니라 통째로 늦췄다가 다시 뭉치게 한다.
   */
  it('지터가 폭 전체에 고르게 흩어진다', () => {
    const at = (rand) =>
      nextAttempt({ status: 429, headers: { 'Retry-After': '7' } }, 0, { spreadMs: 10_000, rand }).waitMs;

    assert.equal(at(() => 0), 7000);
    assert.equal(at(() => 0.5), 12_000);
    assert.equal(at(() => 0.999), 16_990);
  });

  it('지터를 빼면 무리가 같은 순간에 깨어난다', () => {
    // 같은 응답을 받은 단말 열이 서로 다른 시각을 받아야 한다. 지터가 없는
    // 구현이면 열이 전부 같은 값이라 이 집합의 크기가 1이 된다.
    const waits = new Set();
    for (let i = 0; i < 10; i++) {
      waits.add(nextAttempt({ status: 429, headers: { 'Retry-After': '7' } }, 0, {
        spreadMs: 100_000,
        rand: () => i / 10,
      }).waitMs);
    }
    assert.equal(waits.size, 10);
  });

  it('정해진 횟수를 넘기면 포기하고 그 사실을 남긴다', () => {
    const opts = { maxAttempts: 5, rand: () => 0 };
    const res = { status: 429, headers: { 'Retry-After': '7' } };

    // 다섯 번까지다 — 0..3은 더 두드리고, 4는 다섯 번째라 여기서 끝난다.
    assert.equal(nextAttempt(res, 3, opts).retry, true);
    const last = nextAttempt(res, 4, opts);
    assert.equal(`${last.retry} ${last.reason}`, 'false gave-up');
  });

  it('기본 횟수가 무한이 아니다', () => {
    const res = { status: 429, headers: { 'Retry-After': '7' } };
    assert.equal(nextAttempt(res, DEFAULT_MAX_ATTEMPTS, {}).retry, false);
  });
});
