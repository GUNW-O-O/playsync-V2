import '@testing-library/jest-dom/vitest';
import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from '@/mocks/server';

// 테스트 환경에서는 상대 경로 fetch가 불가능하다. 오리진을 고정해 두고
// apiUrl()이 이 값을 앞에 붙인다.
process.env.NEXT_PUBLIC_API_BASE = 'http://localhost:3000';

// 핸들러 없는 요청을 통과시키면 목업이 빠진 것을 못 알아챈다. 에러로 세운다.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
