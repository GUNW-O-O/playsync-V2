import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionRevokedOverlay from './SessionRevokedOverlay';

describe('SessionRevokedOverlay', () => {
  it('이유와 힌트를 그리고 대기 화면으로 가는 링크를 건다', () => {
    render(<SessionRevokedOverlay reason="해제됨" hint="OTP를 다시 넣으세요." href="/table?store=s1" />);
    expect(screen.getByText('해제됨')).toBeInTheDocument();
    expect(screen.getByText('OTP를 다시 넣으세요.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '대기 화면으로' })).toHaveAttribute('href', '/table?store=s1');
  });

  it('href가 없으면 링크 없이 머문다', () => {
    render(<SessionRevokedOverlay reason="해제됨" hint="힌트" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
