import { Role } from '@prisma/client';

/**
 * DEALER 페이로드의 tokenVersion 전달.
 *
 * `DealerService.refreshToken`은 세션에 저장된 tokenVersion과 토큰에 실린
 * tokenVersion을 비교해 폐기 여부를 판정한다. `validate`가 DEALER 분기에서
 * `sub`를 `id`로 개명하면서 `tokenVersion`을 빠뜨리면, 컨트롤러가 넘기는
 * `req.user.tokenVersion`은 `undefined`가 되고 `undefined !== 0`이라 모든
 * 갱신이 거부된다.
 *
 * `dealer.int-spec.ts`의 갱신 테스트는 `jwtService.verify(accessToken)`이
 * 돌려주는 원본 JWT 페이로드(`sub`, `tokenVersion` 그대로)를 `refreshToken`에
 * 직접 넘긴다 — `JwtStrategy.validate`를 지나지 않는다. 그래서 그 경로가
 * 깨져도 통합 테스트는 초록으로 남는다. 이 단위 테스트가 `validate`의 출력
 * 자체를 검증하는 유일한 지점이다.
 */
describe('JwtStrategy', () => {
  const original = process.env.JWT_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  /**
   * `jwt.strategy.ts`는 모듈 로드 시점에 `JWT_SECRET`을 요구한다
   * (`jwt-secret.spec.ts` 참고). `jest.isolateModules`로 격리된 레지스트리에서
   * 다시 로드해 매 호출이 독립적인 인스턴스를 얻게 한다.
   */
  function loadStrategy() {
    process.env.JWT_SECRET = 'jwt-strategy-spec-secret';
    let JwtStrategyCtor: any;
    jest.isolateModules(() => {
      JwtStrategyCtor = require('./jwt.strategy').JwtStrategy;
    });
    return new JwtStrategyCtor();
  }

  it('DEALER 페이로드를 req.user 모양 그대로 내보낸다', async () => {
    const strategy = loadStrategy();

    const result = await strategy.validate({
      role: Role.DEALER,
      sub: 'session-1',
      tournamentId: 'tournament-1',
      tableId: 'table-1',
      tokenVersion: 3,
    });

    // 필드 하나가 아니라 객체 전체를 단언한다. `tokenVersion`만 보면 바로 옆의
    // `sub` → `id` 개명이 무방비로 남는다 — `dealer.controller.ts`가
    // `req.user.id`를 `refreshToken`의 `sub`로 넘기므로, 그 줄이 사라지거나
    // 플레이어 분기처럼 `userId`로 "정리"되면 모든 갱신이 영구 403이 된다.
    // 그리고 그 회귀도 단위·통합 전체가 초록인 채로 지나간다.
    expect(result).toEqual({
      id: 'session-1',
      tournamentId: 'tournament-1',
      tableId: 'table-1',
      tokenVersion: 3,
      role: Role.DEALER,
    });
  });
});
