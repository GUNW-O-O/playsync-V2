import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PlayerLayout from './layout';

// 하단 탭이 `usePathname`으로 지금 탭을 고른다. jsdom에는 라우터가 없다.
const pathname = vi.hoisted(() => ({ value: '/me' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}));

describe('플레이어 레이아웃', () => {
  it('본문 아래에 주요 메뉴를 둔다', () => {
    render(<PlayerLayout>{<p>본문</p>}</PlayerLayout>);

    const nav = screen.getByRole('navigation', { name: '주요 메뉴' });
    const main = screen.getByRole('main');

    expect(screen.getByText('본문')).toBeInTheDocument();
    // 모바일 하단 탭이라 본문보다 뒤에 온다. 콘솔 레이아웃과 뒤바뀌면 깨진다.
    expect(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('대회와 내 정보로 연결한다', () => {
    render(<PlayerLayout>{<p>본문</p>}</PlayerLayout>);

    expect(screen.getByRole('link', { name: '대회' })).toHaveAttribute('href', '/tournaments');
    expect(screen.getByRole('link', { name: '내 정보' })).toHaveAttribute('href', '/me');
  });

  it('지금 보고 있는 탭에 aria-current를 준다', () => {
    pathname.value = '/me';
    render(<PlayerLayout>{<p>본문</p>}</PlayerLayout>);

    expect(screen.getByRole('link', { name: '내 정보' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '대회' })).not.toHaveAttribute('aria-current');
  });

  /**
   * 대회 **상세**(`/tournaments/<id>`)도 대회 탭이다. 정확히 일치로만
   * 보면 상세를 여는 순간 두 탭이 다 꺼진다 — 앞 검사(`/me`)만으로는
   * 그 차이를 못 잡는다. 둘이 어긋나는 입력이라야 각각이 증명된다.
   */
  it('대회 상세에서도 대회 탭이 켜져 있다', () => {
    pathname.value = '/tournaments/abc-123';
    render(<PlayerLayout>{<p>본문</p>}</PlayerLayout>);

    expect(screen.getByRole('link', { name: '대회' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '내 정보' })).not.toHaveAttribute('aria-current');
  });
});
