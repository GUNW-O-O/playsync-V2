import { describe, it, expect } from 'vitest';
import {
  DEALER_OFFSET_MS,
  MAX_ATTEMPTS,
  SEAT_SPREAD_MS,
  reconnectDelayMs,
  retryAfterMs,
  waitFor,
} from '@/lib/reconnect-policy';

/** 지터를 고정한다 — "몇 초 뒤인가"를 실제로 기다리지 않고 본다. */
const fixed = (v: number) => () => v;

describe('reconnectDelayMs', () => {
  /**
   * **첫 시도도 기다린다.** 0으로 두면 서버가 돌아온 순간 전원이 같은 밀리초에
   * 몰려 지터가 있으나 마나가 된다 — 막으려는 대상이 바로 그 순간이다.
   */
  it('첫 시도부터 폭 안에 흩는다', () => {
    expect(reconnectDelayMs(0, 'seat', fixed(0))).toBe(0);
    expect(reconnectDelayMs(0, 'seat', fixed(0.5))).toBe(SEAT_SPREAD_MS / 2);
  });

  /**
   * **이것이 「딜러를 마지막에 붙인다」의 전부다.** 딜러의 **가장 이른** 시각이
   * 좌석의 **가장 늦은** 시각보다 뒤여야 순서가 보장된다. 한쪽만 보면
   * (예: 평균끼리) 꼬리에서 겹치는 구현도 통과한다.
   */
  it('딜러의 가장 이른 시각이 좌석의 가장 늦은 시각보다 뒤다', () => {
    const 좌석최대 = reconnectDelayMs(0, 'seat', fixed(0.999))!;
    const 딜러최소 = reconnectDelayMs(0, 'dealer', fixed(0))!;
    expect(딜러최소).toBeGreaterThanOrEqual(좌석최대);
  });

  it('딜러끼리도 흩어진다 — 한 점에 모이지 않는다', () => {
    const 이른 = reconnectDelayMs(0, 'dealer', fixed(0))!;
    const 늦은 = reconnectDelayMs(0, 'dealer', fixed(0.9))!;
    expect(늦은).toBeGreaterThan(이른);
  });

  /**
   * 거듭 실패하면 폭을 넓힌다. 상한이 30초 블록을 걸고 있으면 같은 폭으로
   * 계속 두드려 봐야 전부 429다.
   */
  it('실패가 쌓이면 폭이 넓어진다', () => {
    const 배수 = [0, 1, 2, 3].map((n) => reconnectDelayMs(n, 'seat', fixed(0.5))!);
    expect(배수).toEqual([20_000, 40_000, 80_000, 160_000]);
  });

  /**
   * 폭이 무한히 커지면 마지막 시도가 몇 시간 뒤가 된다. 세 번에서 멈춘다 —
   * 이 검사가 없으면 상한 없는 구현도 위 검사를 통과한다.
   */
  it('넓히기는 멈춘다', () => {
    expect(reconnectDelayMs(4, 'seat', fixed(0.5))).toBe(reconnectDelayMs(3, 'seat', fixed(0.5)));
  });

  /**
   * **바닥을 만들지 않는다.** `폭/2`를 최소로 깔면 일찍 열린 문을 못 쓴다.
   * 지터가 0을 뽑을 수 있어야 무리의 앞머리가 곧바로 들어간다.
   */
  it('지터가 0이면 기다리지 않는다 — 좌석 첫 시도', () => {
    expect(reconnectDelayMs(0, 'seat', fixed(0))).toBe(0);
  });

  it('정해진 횟수를 넘기면 포기한다', () => {
    expect(reconnectDelayMs(MAX_ATTEMPTS - 1, 'seat', fixed(0))).not.toBeNull();
    expect(reconnectDelayMs(MAX_ATTEMPTS, 'seat', fixed(0))).toBeNull();
  });
});

describe('retryAfterMs', () => {
  const headersOf = (v?: string) => new Headers(v === undefined ? {} : { 'Retry-After': v });

  it('초를 밀리초로 읽는다', () => {
    // 기본 블록(30초)도 창(60초)도 아닌 값이라야 "읽었다"가 증명된다.
    expect(retryAfterMs(headersOf('7'))).toBe(7000);
  });

  it('헤더가 없으면 초를 지어내지 않는다', () => {
    expect(retryAfterMs(headersOf())).toBeNull();
  });

  /**
   * `Number('')`는 0이다. 빈 헤더를 "0초 뒤"로 읽으면 막힌 문을 곧바로 다시
   * 두드려 블록이 갱신된다.
   */
  it.each([[''], ['abc'], ['-1'], ['Wed, 21 Oct 2026 07:28:00 GMT']])(
    '%p는 읽을 수 없어 null이다',
    (raw) => {
      expect(retryAfterMs(headersOf(raw))).toBeNull();
    },
  );
});

describe('waitFor', () => {
  /**
   * 바닥과 지터가 **다른 일을 한다.** 바닥만 쓰면 막힌 단말 전원이 같은 순간에
   * 깨어나고, 지터만 쓰면 아직 닫힌 문을 때린다. 둘을 더한 값인지 본다.
   */
  it('서버가 말한 바닥 위에 지터를 얹는다', () => {
    expect(waitFor(0, 'seat', 7000, fixed(0.5))).toBe(7000 + SEAT_SPREAD_MS / 2);
  });

  it('바닥이 없으면 지터만이다', () => {
    expect(waitFor(0, 'seat', null, fixed(0.5))).toBe(SEAT_SPREAD_MS / 2);
  });

  it('딜러의 바닥에도 뒤로 미는 offset이 살아 있다', () => {
    expect(waitFor(0, 'dealer', 7000, fixed(0))).toBe(7000 + DEALER_OFFSET_MS);
  });

  it('포기한 뒤에는 null이다', () => {
    expect(waitFor(MAX_ATTEMPTS, 'seat', 7000, fixed(0))).toBeNull();
  });
});
