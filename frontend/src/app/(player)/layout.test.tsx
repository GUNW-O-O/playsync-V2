import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PlayerLayout from './layout';

describe('플레이어 레이아웃', () => {
  it('하단 탭과 본문을 함께 그린다', () => {
    render(<PlayerLayout>{<p>본문</p>}</PlayerLayout>);

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('본문')).toBeInTheDocument();
  });
});
