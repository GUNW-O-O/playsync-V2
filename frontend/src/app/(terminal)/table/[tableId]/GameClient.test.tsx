import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

// PokerTable·ActionPanel은 각자 다른 의존성(next/navigation 등)을 끌고
// 온다. 이 테스트가 검증하려는 건 티켓 fetch 실패 처리뿐이므로 자식은
// 렌더만 되면 그만이다.
vi.mock('./PokerTable', () => ({ default: () => null }));
vi.mock('./ActionPanel', () => ({ default: () => null }));

const GameClient = (await import('./GameClient')).default;

/**
 * `/api/ws-ticket`이 네트워크 단절(브라우저 확장 차단 등)로 reject되는
 * 경우를 다룬다. 리뷰 지적: async IIFE에 try/catch가 없으면 이 reject가
 * 어디서도 잡히지 않는 처리되지 않은 프라미스 거부로 새어 나간다.
 */
describe('GameClient', () => {
  beforeEach(() => {
    // 상대 경로 '/api/ws-ticket'을 그대로 매칭하려면 와일드카드가 필요하다.
    server.use(http.post('*/api/ws-ticket', () => HttpResponse.error()));
  });

  it('티켓 요청이 네트워크 실패해도 처리되지 않은 거부 없이 콘솔 에러로만 끝난다', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(<GameClient tableId="tbl-1" seatIndex={0} initIsDealer={false} />),
    ).not.toThrow();

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());

    errorSpy.mockRestore();
  });

  /**
   * 리뷰 지적: 티켓 발급이 401·403을 줘도 화면이 "멀쩡해 보이지만 아무것도
   * 안 움직이는" 상태로 멈췄다. 딜러 클릭이 게임 진행의 트리거인 시스템에서
   * 가장 나쁜 실패 모드라, 최소한 눈에 띄는 배너로 알린다.
   */
  it('티켓 발급이 403이면 화면에 배너가 뜬다', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.post('*/api/ws-ticket', () =>
        HttpResponse.json({ message: '만료된 딜러 세션입니다.' }, { status: 403 }),
      ),
    );

    render(<GameClient tableId="tbl-1" seatIndex={-1} initIsDealer={true} />);

    await waitFor(() => expect(screen.getByText('만료된 딜러 세션입니다.')).toBeInTheDocument());

    errorSpy.mockRestore();
  });

  it('서버가 문구를 안 주면 기본 안내 문구를 보여준다', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(http.post('*/api/ws-ticket', () => new HttpResponse(null, { status: 500 })));

    render(<GameClient tableId="tbl-1" seatIndex={-1} initIsDealer={true} />);

    await waitFor(() =>
      expect(
        screen.getByText('연결이 끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요.'),
      ).toBeInTheDocument(),
    );

    errorSpy.mockRestore();
  });
});
