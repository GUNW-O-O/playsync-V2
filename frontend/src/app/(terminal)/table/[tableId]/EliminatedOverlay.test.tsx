import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EliminatedOverlay from './EliminatedOverlay';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

/** `EliminatedOverlay`의 `COUNTDOWN_SECONDS`와 같은 값. */
const COUNTDOWN_SECONDS = 7;

describe('EliminatedOverlay', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 카운트다운은 `setTimeout` 하나를 `secondsLeft`가 바뀔 때마다 새로
   * 거는 모양이라, 한 번에 8초를 미는 것으로는 두 번째 이후 타이머가 안
   * 걸린다 — 다음 타이머는 React가 다시 렌더한 **뒤에야** 생긴다. 1초씩
   * 밀어 그 사이에 렌더가 끼어들 자리를 준다.
   */
  async function runCountdown() {
    for (let i = 0; i <= COUNTDOWN_SECONDS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
  }

  it('상점 id가 있으면 카운트다운 뒤 그 상점의 대기 화면으로 돌아간다', async () => {
    vi.useFakeTimers();
    render(<EliminatedOverlay storeId="store-9" reason="eliminated" />);

    await runCountdown();

    expect(push).toHaveBeenCalledWith('/table?store=store-9');
  });

  /**
   * T67-3에 물려 있는 것. `getTableContext`가 `tournamentId`를 못 구하면
   * `storeId`도 `undefined`가 되고, 그때 `/table?store=`로 보내면 대기
   * 화면이 **"주소에 상점이 없습니다."**를 띄운다(`(terminal)/table/page.tsx`).
   * 태블릿이 스스로 막다른 곳에 서고, 거기서 돌아올 조작이 화면에 없다 —
   * 다음 손님이 앉을 자리다.
   *
   * 갈 곳을 모르면 **가지 않는다.** 그 자리에 머무는 편이 낫다.
   */
  it('상점 id가 없으면 막다른 주소로 자동 이동하지 않는다', async () => {
    vi.useFakeTimers();
    render(<EliminatedOverlay reason="eliminated" />);

    await runCountdown();

    expect(push).not.toHaveBeenCalled();
  });

  it('상점 id가 없으면 카운트다운 대신 운영자 안내를 보여준다', async () => {
    render(<EliminatedOverlay reason="eliminated" />);

    expect(screen.getByText(/운영자/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /지금 돌아가기/ })).not.toBeInTheDocument();
  });

  it('상점 id가 있으면 지금 돌아가기 버튼이 그 주소로 보낸다', async () => {
    render(<EliminatedOverlay storeId="store-9" reason="eliminated" />);

    await userEvent.click(screen.getByRole('button', { name: /지금 돌아가기/ }));

    expect(push).toHaveBeenCalledWith('/table?store=store-9');
  });

  /**
   * 두 사유는 사람이 할 일이 정반대다 — 한쪽은 폰을 열어 등수를 보는 것이고
   * 다른 쪽은 **일어나 걸어가는 것**이다. 그래서 서로 상대의 문장이 없는
   * 것까지 본다: 한 문구만 확인하면 둘 다 그리는 구현도 통과한다.
   */
  it('탈락이면 칩이 0이 됐다고 적고 자리 이동 안내는 안 한다', () => {
    render(<EliminatedOverlay storeId="store-9" reason="eliminated" />);

    expect(screen.getByText(/칩이 0이 되어/)).toBeInTheDocument();
    expect(screen.getByText('탈락')).toBeInTheDocument();
    expect(screen.queryByText(/새 자리로 가서/)).not.toBeInTheDocument();
  });

  it('좌석 해제면 칩이 그대로임을 적고 탈락이라 말하지 않는다', () => {
    render(<EliminatedOverlay storeId="store-9" reason="seat-released" />);

    expect(screen.getByText(/자리를 이동해 주세요/)).toBeInTheDocument();
    expect(screen.getByText(/칩은 그대로입니다/)).toBeInTheDocument();
    expect(screen.queryByText(/칩이 0이 되어/)).not.toBeInTheDocument();
  });
});
