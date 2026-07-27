import { describe, it, expect, vi, beforeEach } from 'vitest';

const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect }));

const HomePage = (await import('./page')).default;

// 명세상 랜딩 페이지는 없다. 익명 사용자는 미들웨어가 이미 로그인으로 보내지만
// 로그인한 사용자가 /를 열면 갈 곳이 없다.
describe('루트 경로', () => {
  beforeEach(() => redirect.mockClear());

  it('로그인으로 보낸다', () => {
    HomePage();

    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
