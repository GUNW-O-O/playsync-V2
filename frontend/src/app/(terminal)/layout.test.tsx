import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TerminalLayout from './layout';

describe('단말 레이아웃', () => {
  it('본문만 그리고 크롬을 두지 않는다', () => {
    render(<TerminalLayout>{<p>본문</p>}</TerminalLayout>);

    expect(screen.getByText('본문')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
