import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WinnerOverlay from './WinnerOverlay';

// 자리 번호를 넣는다. 딜러가 보는 것은 눈앞의 테이블이라 화면이 이름 앞에
// 자리를 붙이고(`nameOf`), 실제 호출부(`DealerGameClient`)도 늘 함께 넘긴다.
const PLAYERS = [
  { id: 'u1', nickname: 'A', hasFolded: false, seatIndex: 0 },
  { id: 'u2', nickname: 'B', hasFolded: true, seatIndex: 1 },
  { id: 'u3', nickname: 'C', hasFolded: false, seatIndex: 2 },
];

/**
 * 모양의 출처: `TableState.sidePots`(`app/types/game.ts`). 층은 서버가
 * `calculateSidePots`로 만들고, 자격자도 서버가 정한다.
 */
const SIDE_POTS = [
  { amount: 3000, relevantPlayerIds: ['u1', 'u2', 'u3'] },
  { amount: 7600, relevantPlayerIds: ['u2', 'u3'] },
];

describe('WinnerOverlay', () => {
  /**
   * 딜러가 순위를 찍는 화면에 **팟이 몇 층이고 누가 어느 층의 자격자인지**가
   * 있어야 한다. 없으면 1등만 찍고 배분을 눌러 거절당하고서야 층이 둘이었다는
   * 것을 알게 된다(T15가 막는 그 실수다).
   */
  it('층과 자격자를 자리·이름으로 보여준다', () => {
    render(
      <WinnerOverlay
        players={PLAYERS}
        sidePots={SIDE_POTS}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/사이드팟이 2개 있습니다/)).toBeInTheDocument();
    const second = screen.getByTestId('winner-pot-1');
    expect(second).toHaveTextContent('7,600');
    // 1층의 자격자였던 A는 2층에 없다 — 낼 돈이 없었기 때문이고, 그것이
    // 층이 갈린 이유 그 자체다.
    expect(second).not.toHaveTextContent('1번 · A');
    expect(second).toHaveTextContent('2번 · B');
  });

  it('사이드팟이 없으면 목록을 그리지 않는다', () => {
    // 팟이 안 갈린 판이 대부분이다. 거기까지 층을 그리면 매번 읽을 것이
    // 늘어나기만 한다.
    render(
      <WinnerOverlay
        players={PLAYERS}
        sidePots={[{ amount: 3000, relevantPlayerIds: ['u1', 'u2', 'u3'] }]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('winner-pot-0')).toBeNull();
  });

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
