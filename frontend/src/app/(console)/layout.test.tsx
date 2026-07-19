import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConsoleLayout from './layout';

describe('콘솔 레이아웃', () => {
  it('사이드바와 본문을 함께 그린다', () => {
    render(<ConsoleLayout>{<p>본문</p>}</ConsoleLayout>);

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('본문')).toBeInTheDocument();
  });
});
