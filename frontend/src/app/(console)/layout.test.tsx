import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConsoleLayout from './layout';

describe('콘솔 레이아웃', () => {
  it('본문 위에 콘솔 메뉴를 둔다', () => {
    render(<ConsoleLayout>{<p>본문</p>}</ConsoleLayout>);

    const nav = screen.getByRole('navigation', { name: '콘솔 메뉴' });
    const main = screen.getByRole('main');

    expect(screen.getByText('본문')).toBeInTheDocument();
    // 데스크톱 사이드바라 본문보다 앞선다. 플레이어 레이아웃과 뒤바뀌면 깨진다.
    expect(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('상점과 플랫폼 관리로 연결한다', () => {
    render(<ConsoleLayout>{<p>본문</p>}</ConsoleLayout>);

    expect(screen.getByRole('link', { name: '상점' })).toHaveAttribute('href', '/stores');
    expect(screen.getByRole('link', { name: '플랫폼 관리' })).toHaveAttribute('href', '/admin');
  });
});
