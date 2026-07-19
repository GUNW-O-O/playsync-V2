import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

const ActionPanel = (await import('./ActionPanel')).default;

const state = {
  smallBlind: 100,
  currentBet: 0,
  currentTurnSeatIndex: 0,
  phase: 1,
  pot: 0,
  players: [{ id: 'u-1', nickname: '플레이어', stack: 5000, bet: 0 }],
};

const rebuyData = {
  tournamentName: '테스트 대회',
  userPoints: { points: 10000 },
  entryFee: 3000,
  deadline: Date.now() + 30000,
};

// 좌석 태블릿은 테이블에 고정된 기기다. 리바인을 거절하면 자리를 비울 뿐
// 단말이 다른 화면으로 떠나지 않는다 — 서버가 빈 좌석 상태를 다시 내려주도록
// 같은 라우트를 새로고침한다.
describe('리바인 거절', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
  });

  it('테이블 화면에 머문 채 새로고침한다', () => {
    const onRebuyResponse = vi.fn();

    render(
      <ActionPanel
        state={state}
        mySeatIndex={0}
        isDealer={false}
        onAction={vi.fn()}
        onRebuyResponse={onRebuyResponse}
        rebuyData={rebuyData}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'EXIT' }));

    expect(onRebuyResponse).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
