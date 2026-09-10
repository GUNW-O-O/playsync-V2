import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify, firstLimitIndex, isClean } from './door.js';

/**
 * 로그인 문(throttle.ts의 인증 상한) 판정 모듈의 테스트.
 *
 * `windows.js`와 같은 이유로 순수 모듈로 뺐다 — 시나리오 클로저 안에 있으면
 * "실행 요약을 사람이 읽는 것" 말고는 검증할 길이 없다.
 */

describe('classify', () => {
  it('2xx는 통과다', () => {
    assert.equal(classify({ status: 200 }), 'pass');
    assert.equal(classify({ status: 201 }), 'pass');
  });

  it('429는 상한이다', () => {
    assert.equal(classify({ status: 429 }), 'limited');
  });

  it('429가 아닌 실패는 상한으로 세지 않는다 — 그 밖의 실패다', () => {
    // 비밀번호가 틀렸을 때(401), 서버 오류(500), 연결 자체가 끊긴 경우(k6는 0)를
    // 상한으로 세면 "문이 몇 개에서 닫히나"라는 질문에 거짓으로 답하게 된다.
    assert.equal(classify({ status: 401 }), 'other');
    assert.equal(classify({ status: 500 }), 'other');
    assert.equal(classify({ status: 0 }), 'other');
  });
});

describe('firstLimitIndex', () => {
  it('429가 하나도 없으면 null이다', () => {
    const responses = [{ status: 200 }, { status: 200 }, { status: 200 }];
    assert.equal(firstLimitIndex(responses), null);
  });

  it('첫 건이 429면 1이다', () => {
    const responses = [{ status: 429 }, { status: 200 }, { status: 200 }];
    assert.equal(firstLimitIndex(responses), 1);
  });

  it('마지막 건만 429면 그 순번이다', () => {
    const responses = [{ status: 200 }, { status: 200 }, { status: 429 }];
    assert.equal(firstLimitIndex(responses), 3);
  });

  it('중간에 처음 걸리면 그 순번을 낸다 — 그 뒤에 또 있어도 첫 번째만 본다', () => {
    const responses = [{ status: 200 }, { status: 429 }, { status: 429 }];
    assert.equal(firstLimitIndex(responses), 2);
  });
});

describe('isClean', () => {
  it('429가 하나도 없고 통과가 있으면 깨끗하다', () => {
    const responses = [{ status: 200 }, { status: 200 }, { status: 200 }];
    assert.equal(isClean(responses), true);
  });

  it('첫 건이 429면 깨끗하지 않다', () => {
    const responses = [{ status: 429 }, { status: 200 }, { status: 200 }];
    assert.equal(isClean(responses), false);
  });

  it('마지막 건만 429여도 깨끗하지 않다 — 퍼센트 여지를 두지 않는다', () => {
    const responses = [{ status: 200 }, { status: 200 }, { status: 429 }];
    assert.equal(isClean(responses), false);
  });

  /**
   * **이 검사가 가장 잡기 쉬운 함정이다.**
   *
   * "상한이 하나도 없으면 깨끗하다"만 구현하면, 서버가 죽어 전부 500이 나온
   * 구간도 429가 없다는 이유로 깨끗함이 되어 버린다. 그러면 도착률 계단에서
   * 서버가 죽은 구간을 "문제없음"으로 잘못 읽는다 — 문이 열려 있었는지
   * 자체를 증명하지 못했는데 깨끗함으로 세는 것이다.
   */
  it('429가 아닌 실패만 있는 열은 깨끗함으로 판정되지 않는다', () => {
    const responses = [{ status: 500 }, { status: 500 }, { status: 401 }];
    assert.equal(isClean(responses), false);
  });

  it('빈 열은 깨끗함으로 판정되지 않는다 — 잰 것이 없다', () => {
    assert.equal(isClean([]), false);
  });
});
