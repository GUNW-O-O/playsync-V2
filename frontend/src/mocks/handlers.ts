import type { RequestHandler } from 'msw';

/**
 * 전역 목 핸들러는 비어 있다.
 *
 * 목은 백엔드를 **병렬로** 만들던 시절의 도구였다. 백엔드가 다 선 지금
 * 전역 목이 하는 일은 둘뿐이다. (1) 실제와 다른 규약을 하나 더 만든다 —
 * 여기 있던 와일드카드 `/api/auth/login` 핸들러는 프로덕션 호출자가 0개였고, 실존하는 로그인
 * 코드(`auth/action.ts`)는 `${BACKEND_URL}/auth/login`으로 나간다.
 * (2) 목이 틀렸다는 사실을 아무것도 알려주지 않는다.
 *
 * 그래서 응답이 필요한 테스트는 **그 테스트 안에서** `server.use(...)`로
 * 등록하고, 모양의 출처를 백엔드 코드 위치로 주석에 남긴다. 등록되지 않은
 * 요청은 `vitest.setup.ts`의 `onUnhandledRequest: 'error'`가 실패로 만든다 —
 * 목이 빠진 것을 조용히 지나가지 않는다.
 */
export const handlers: RequestHandler[] = [];
