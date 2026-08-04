import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WinnerOverlay from './WinnerOverlay';

const PLAYERS = [
  { id: 'u1', nickname: 'A', hasFolded: false },
  { id: 'u2', nickname: 'B', hasFolded: true },
  { id: 'u3', nickname: 'C', hasFolded: false },
];

describe('WinnerOverlay', () => {
  it('보드 하이는 폴드하지 않은 전원을 한 그룹으로 보낸다', async () => {
    const onSubmit = vi.fn();
    render(<WinnerOverlay players={PLAYERS} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /보드 하이/ }));
    expect(onSubmit).toHaveBeenCalledWith([['u1', 'u3']]);
  });

  it('폴드한 사람은 승자로 고를 수 없다', () => {
    render(<WinnerOverlay players={PLAYERS} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('winner-pick-u2')).toBeDisabled();
  });
});
