import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PlayerLayout from './layout';

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
});
