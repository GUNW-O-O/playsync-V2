/**
 * JWT 서명 키는 환경변수에서만 온다.
 *
 * 기본값이 있으면 배포가 조용히 성공한다 — 그리고 그 키는 리포지토리에 적혀
 * 있으므로, 아무나 STORE_ADMIN 토큰을 만들어 서명할 수 있다. 인증이 있는 척만
 * 하는 상태라 로그에도 아무것도 남지 않는다.
 *
 * 그래서 검증 지점을 런타임이 아니라 **모듈 로드 시점**에 둔다. 부팅이 실패하면
 * 배포 파이프라인이 막히지만, 잘못된 키로 뜬 서버는 아무도 막지 못한다.
 * main.ts 첫 줄의 `import 'dotenv/config'`가 다른 모든 import보다 먼저
 * 평가되므로, 모듈 스코프에서 process.env를 읽어도 .env는 이미 적용돼 있다.
 */
describe('JWT_SECRET 환경변수', () => {
  const original = process.env.JWT_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  const load = (path: string) => {
    let error: unknown;
    jest.isolateModules(() => {
      try {
        require(path);
      } catch (e) {
        error = e;
      }
    });
    return error;
  };

  describe.each([
    ['auth.module', './auth.module'],
    ['jwt.strategy', './strategies/jwt.strategy'],
  ])('%s', (_name, path) => {
    it('설정돼 있으면 정상 로드된다', () => {
      process.env.JWT_SECRET = 'unit-test-secret';

      expect(load(path)).toBeUndefined();
    });

    it('없으면 로드 단계에서 던진다', () => {
      delete process.env.JWT_SECRET;

      expect(load(path)).toMatchObject({ message: expect.stringContaining('JWT_SECRET') });
    });

    it('빈 문자열도 없는 것으로 본다', () => {
      // JWT_SECRET= 만 적힌 .env는 흔한 실수인데, 빈 키로도 서명은 된다.
      process.env.JWT_SECRET = '';

      expect(load(path)).toMatchObject({ message: expect.stringContaining('JWT_SECRET') });
    });
  });
});
