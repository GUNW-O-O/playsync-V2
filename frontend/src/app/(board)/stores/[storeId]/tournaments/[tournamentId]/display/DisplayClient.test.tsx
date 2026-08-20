import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import DisplayClient from './DisplayClient';

// DisplayClient.tsx의 POLL_MS와 같은 값. export되어 있지 않아 직접 든다 —
// 값이 갈라지면 이 테스트가 페이크 타이머를 잘못된 간격으로 밀게 되어
// 스스로 실패한다.
const POLL_MS = 1000;

// packages/contract/src/dashboard.spec.ts의 VALID와 같은 모양. 백엔드 출처는
// backend/shared/types/tournamentMeta.ts(Dashboard·BlindField)와
// backend/shared/dto/blind-structure.dto.ts(BlindLevelDto)다.
const VALID = {
  dashboard: {
    isRegistrationOpen: true, totalPlayer: 20, activePlayer: 7,
    totalBuyinAmount: 350000, rebuyUntil: 0, avgStack: 50000,
    tournamentName: '데모 토너먼트', entryFee: 50000, startStack: 30000,
    itmCount: 3, prizePool: 350000,
    prizes: [{ place: 1, percent: 50, amount: 175000 }],
  },
  blindField: {
    isBreak: false, startedAt: 0, currentBlindLv: 0,
    nextLevelAt: 1000, serverTime: 0,
    blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 10 }],
  },
};

describe('DisplayClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 리뷰 지적(Important): 초기 상태(`info === null`)가 이미 "대기 중"이라,
   * 첫 렌더만 보는 테스트는 빈 본문 분기(`text.length === 0` →
   * `setInfo(null)`)를 한 줄도 실행하지 않아도 통과했다. 그래서 **전이**를
   * 본다 — 유효한 응답으로 평상시 화면이 뜬 뒤, 다음 폴링이 진짜 빈 200을
   * 받았을 때 "대기 중"으로 돌아오는지. 이래야 `setInfo(null)`이 실제로
   * 실행됐다는 것이 증명된다.
   *
   * Nest가 null을 반환하면 본문이 비어서 나간다(playsync.controller.ts:22 →
   * redis.service.ts:287). HttpResponse.json(null)은 본문이 "null"이라
   * 실제와 다르므로, 두 번째 응답부터는 진짜 빈 본문을 먹인다.
   */
  it('평상시 화면이 뜬 뒤 다음 폴링이 빈 본문이면 대기 중으로 돌아온다', async () => {
    let pollCount = 0;
    server.use(
      http.get('*/playsync/dashboard/:id', () => {
        pollCount += 1;
        return pollCount === 1
          ? HttpResponse.json(VALID)
          : new HttpResponse(null, { status: 200 });
      }),
    );

    vi.useFakeTimers();
    render(<DisplayClient tournamentId="t1" />);

    // 마운트 시 즉시 실행되는 첫 폴링이 평상시 화면을 그릴 때까지 마이크로
    // 태스크를 흘려보낸다. msw의 fetch 응답은 페이크 타이머가 흉내내지
    // 않는 프라미스 체인으로 오므로 실시간 타이머 없이도 풀린다.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('350,000')).toBeInTheDocument();

    // 다음 폴링 주기(POLL_MS)를 페이크 타이머로 민다 — 이번엔 빈 본문이다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByText('대기 중')).toBeInTheDocument();
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('isBreak면 화면을 통째로 휴식으로 바꾼다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () =>
      HttpResponse.json({ ...VALID, blindField: { ...VALID.blindField, isBreak: true } })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('휴식')).toBeInTheDocument();
    // 배지 하나로는 담배 피우러 나간 사람이 못 본다. 남은 시간만 남기고 지운다.
    expect(screen.queryByText('데모 토너먼트')).not.toBeInTheDocument();
  });

  it('평상시에는 프라이즈풀과 남은 인원이 보인다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByText('350,000')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  /**
   * T58. 칩이 디지털이고 화면이 유일한 장부인데, 딜러가 이 대회에 앤티가
   * 붙는지 전광판으로는 몰랐다. BlindLevel.ante는 구조 층의 값이라 여전히
   * boolean이다 — 얼마인지는 실제 핸드가 도는 Felt가 그린다(state.ante).
   */
  it('현재 레벨에 앤티가 붙으면 배지를 보여준다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json({
      ...VALID,
      blindField: {
        ...VALID.blindField,
        blindStructure: [{ lv: 1, sb: 100, ante: true, duration: 10 }],
      },
    })));
    render(<DisplayClient tournamentId="t1" />);
    expect(await screen.findByTestId('ante-badge')).toBeInTheDocument();
  });

  it('앤티가 없는 레벨에서는 배지가 없다', async () => {
    server.use(http.get('*/playsync/dashboard/:id', () => HttpResponse.json(VALID)));
    render(<DisplayClient tournamentId="t1" />);
    await screen.findByText('350,000');
    expect(screen.queryByTestId('ante-badge')).not.toBeInTheDocument();
  });
});
