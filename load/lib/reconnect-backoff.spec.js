import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextAttempt, retryAfterMs } from './reconnect-backoff.js';

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

describe('nextAttempt', () => {
  it('통과했으면 다시 두드리지 않는다', () => {
    const r = nextAttempt({ status: 200 }, 1234);
    assert.equal(`${r.retry} ${r.reason}`, 'false ok');
  });

  /**
   * **자격이 틀린 4xx는 다시 두드리지 않는다.** 403은 세대가 오른 좌석(T110)이라
   * 단말도 멈추고, 401·404는 다시 와도 같은 답이다.
   */
  it('429가 아닌 4xx는 재시도가 아니다', () => {
    for (const status of [401, 403, 404]) {
      const r = nextAttempt({ status }, 1234);
      assert.equal(`${status} ${r.retry} ${r.reason}`, `${status} false not-limited`);
    }
  });

  /**
   * **서버가 응답을 못 한 것은 다시 두드린다 — 단 사유를 따로 남긴다**(T113).
   * 제품 단말(`useTableSocket`)이 그렇게 하므로 하네스가 여기서 테이블을 죽이면
   * 제품보다 엄격한 것을 잰다. k6는 응답을 못 받으면 0을 준다.
   *
   * **바닥이 없다.** 제품은 429가 아니면 지터만 기다린다(`waitFor`의
   * `floorMs ?? 0`). 예전 하네스는 여기에 30초를 깔았다.
   */
  it('연결 실패(0)와 5xx는 unreachable로 지연만큼 기다린다', () => {
    for (const status of [0, 500, 502, 503]) {
      const r = nextAttempt({ status }, 1234);
      assert.equal(`${status} ${r.retry} ${r.reason} ${r.waitMs}`, `${status} true unreachable 1234`);
    }
  });

  it('429면 `Retry-After`를 바닥으로 지연을 얹는다', () => {
    const r = nextAttempt({ status: 429, headers: { 'Retry-After': '7' } }, 1234);
    assert.equal(`${r.retry} ${r.reason} ${r.waitMs}`, 'true backoff 8234');
  });

  it('`Retry-After`가 없으면 지연만 기다린다', () => {
    const r = nextAttempt({ status: 429, headers: {} }, 1234);
    assert.equal(r.waitMs, 1234);
  });

  /** 지연이 `null`이면 정책이 횟수를 다 썼다(`reconnectDelayMs`). */
  it('지연이 null이면 포기하고 그 사실을 남긴다', () => {
    for (const res of [{ status: 0 }, { status: 429, headers: { 'Retry-After': '7' } }]) {
      const r = nextAttempt(res, null);
      assert.equal(`${res.status} ${r.retry} ${r.reason}`, `${res.status} false gave-up`);
    }
  });
});
