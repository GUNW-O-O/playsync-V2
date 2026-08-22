import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActionTimer from './ActionTimer';

/**
 * **서버 시각과 태블릿 시계는 다르다.**
 *
 * `actionDeadline`은 서버가 만든 절대 시각인데, 타이머가 그것을 브라우저
 * `Date.now()`와 직접 비교했다. 시계가 뒤처진 태블릿은 게이지가 남은 채로
 * 자동 폴드되고, 앞선 태블릿은 이미 지난 턴을 계속 세고 있다. 전광판
 * (`DisplayClient`)은 같은 이유로 `serverTime`으로 오프셋을 보정하는데
 * 여기엔 그것이 없었다.
 *
 * 초기 렌더도 같은 함수의 문제였다. 첫 `setInterval`이 돌기 전 100ms 동안
 * `timeLeft`가 0이라 **"0초 남음"이 잠깐 뜬다** — 차례가 막 온 사람에게
 * 시간이 없다고 말하는 화면이다.
 */
describe('ActionTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('첫 프레임부터 남은 시간을 그린다', () => {
    // 예전에는 첫 인터벌(100ms) 전까지 "0초 남음"이었다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));

    render(<ActionTimer deadline={Date.now() + 30_000} />);

    expect(screen.getByText('30초 남음')).toBeInTheDocument();
  });

  it('태블릿 시계가 뒤처져도 서버 시각으로 센다', () => {
    // 태블릿이 20초 느리다. 보정이 없으면 30초짜리 턴을 50초로 센다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));

    const serverNow = Date.now() + 20_000;

    render(<ActionTimer deadline={serverNow + 30_000} serverNow={serverNow} />);

    expect(screen.getByText('30초 남음')).toBeInTheDocument();
  });

  it('태블릿 시계가 앞서도 서버 시각으로 센다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));

    const serverNow = Date.now() - 20_000;

    render(<ActionTimer deadline={serverNow + 30_000} serverNow={serverNow} />);

    expect(screen.getByText('30초 남음')).toBeInTheDocument();
  });

  it('서버 시각이 없으면 브라우저 시계로 센다', () => {
    // 옛 스냅샷이나 계약 이전 서버. 보정이 없을 뿐 타이머는 돌아야 한다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));

    render(<ActionTimer deadline={Date.now() + 12_000} />);

    expect(screen.getByText('12초 남음')).toBeInTheDocument();
  });
});
