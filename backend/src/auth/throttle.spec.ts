import { authLimit, defaultLimit, throttleWindowMs, throttlerOptions } from './throttle';

/**
 * 값이 아니라 **기본값의 방향**을 못 박는 스펙이다.
 *
 * 한도를 환경변수로 뺀 이유는 부하 무대가 단일 호스트에서 초당 수십 요청을
 * 내기 때문인데(T41의 램프), 그때 흔한 실수가 "기본은 느슨하게, 운영에서만
 * 조인다"이다. 그러면 개발·CI·테스트가 전부 느슨한 쪽만 밟고 조인 설정은
 * 아무도 실행해 보지 않은 코드가 된다 — T51에서 `createTestPrisma()`가 제품과
 * 다른 클라이언트라 통합 394건이 제품 설정을 한 번도 안 밟았던 것과 같은
 * 함정이다. 그래서 **기본값이 방어값**이고 부하 프로파일만 env로 올린다.
 */
describe('요청율 상한 설정', () => {
  it('환경변수가 없으면 방어값이다', () => {
    expect({
      window: throttleWindowMs({}),
      global: defaultLimit({}),
      auth: authLimit({}),
    }).toEqual({ window: 60_000, global: 600, auth: 120 });
  });

  it('인증 라우트가 전역보다 좁다', () => {
    expect(authLimit({})).toBeLessThan(defaultLimit({}));
  });

  it('환경변수가 값을 덮는다 — 부하 프로파일이 쓰는 길이다', () => {
    const env = {
      THROTTLE_WINDOW_MS: '1000',
      THROTTLE_LIMIT: '99999',
      THROTTLE_AUTH_LIMIT: '5000',
    };

    expect({
      window: throttleWindowMs(env),
      global: defaultLimit(env),
      auth: authLimit(env),
    }).toEqual({ window: 1000, global: 99999, auth: 5000 });
  });

  /**
   * 오타 하나로 상한이 사라지면 안 된다. `THROTTLE_LIMIT=`(빈 값)이나
   * `THROTTLE_LIMIT=abc`는 `Number()`가 각각 0과 NaN을 주는데, 0은 **모든
   * 요청을 막고** NaN은 비교가 전부 false라 **아무도 안 막는다.** 둘 다
   * 조용하다 — 뜨는 것도 로그도 없다.
   */
  it.each([
    ['빈 값', ''],
    ['숫자가 아님', 'abc'],
    ['0', '0'],
    ['음수', '-1'],
  ])('쓸 수 없는 값(%s)은 방어값으로 되돌린다', (_label, raw) => {
    expect(defaultLimit({ THROTTLE_LIMIT: raw })).toBe(600);
    expect(authLimit({ THROTTLE_AUTH_LIMIT: raw })).toBe(120);
    expect(throttleWindowMs({ THROTTLE_WINDOW_MS: raw })).toBe(60_000);
  });

  it('ThrottlerModule에 넘길 모양으로 나온다', () => {
    expect(throttlerOptions({ THROTTLE_LIMIT: '7', THROTTLE_WINDOW_MS: '1000' }))
      .toEqual([{ ttl: 1000, limit: 7 }]);
  });
});
