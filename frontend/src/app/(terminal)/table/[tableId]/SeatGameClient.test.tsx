import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import type { TableState } from '@/app/types/game';

// Felt·SeatActionPanel은 각자 다른 렌더링 폭을 가진 컴포넌트다. 이 파일이
// 검증하려는 건 WS 티켓 처리와 탈락 판정뿐이므로 자식은 렌더만 되면 그만이다.
vi.mock('@/component/felt/Felt', () => ({ default: () => null }));
vi.mock('./SeatActionPanel', () => ({ default: () => null }));

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const SeatGameClient = (await import('./SeatGameClient')).default;

/**
 * 실제 WebSocket 대신 세우는 가짜. `renderGame`·`REBUY_PROMPT` 이벤트를
 * `emitServerEvent`로 직접 흘려보낼 수 있다. 서버로 보낸 메시지는
 * `sent`에 쌓인다 — 이 파일의 테스트는 수신 경로만 보므로 지금은 안 읽지만,
 * 다음에 발신을 검증할 때 그대로 쓸 수 있게 남겨 둔다.
 */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' });
  }

  // act()로 감싼다: onmessage가 setState를 동기로 부르지만, WebSocket
  // 콜백은 React 이벤트가 아니라 act가 추적하지 않는다. 감싸지 않으면
  // 커밋이 다음 마이크로태스크로 밀려, 이 직후 줄의 동기 단언(`queryByText`)이
  // 갱신 전 DOM을 본다 — 구현이 틀려도 통과하는 헛도는 테스트가 된다.
  emitServerEvent(event: string, data: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify({ event, data }) });
    });
  }
}

const BASE_STATE: TableState = {
  phase: 1,
  players: [
    null,
    null,
    null,
    {
      id: 'u-1',
      tableId: 'tbl-1',
      nickname: '나',
      seatIndex: 3,
      stack: 5000,
      bet: 0,
      hasFolded: false,
      isAllIn: false,
      button: false,
      totalContributed: 0,
    },
    null,
    null,
    null,
    null,
    null,
  ],
  buttonUser: 0,
  currentTurnSeatIndex: -1,
  pot: 0,
  sidePots: [],
  currentBet: 0,
  smallBlind: 100,
  ante: false,
  tournamentId: 'trn-1',
};

/** WS 배선을 세우고 소켓 인스턴스가 만들어질 때까지 기다린다. */
async function renderWithSocket({ seatIndex = 3 }: { seatIndex?: number } = {}) {
  FakeSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  server.use(http.post('*/api/ws-ticket', () => HttpResponse.json({ ticket: 'tkt-1' })));

  render(
    <SeatGameClient tableId="tbl-1" initialData={BASE_STATE} seatIndex={seatIndex} storeId="store-1" />,
  );

  await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
  const socket = FakeSocket.instances[0];

  return { socket };
}

describe('SeatGameClient', () => {
  beforeEach(() => {
    push.mockClear();
    vi.unstubAllGlobals();
  });

  /**
   * `/api/ws-ticket`이 네트워크 단절(브라우저 확장 차단 등)로 reject되는
   * 경우를 다룬다. 리뷰 지적: async IIFE에 try/catch가 없으면 이 reject가
   * 어디서도 잡히지 않는 처리되지 않은 프라미스 거부로 새어 나간다.
   */
  describe('WS 티켓 처리', () => {
    beforeEach(() => {
      // 상대 경로 '/api/ws-ticket'을 그대로 매칭하려면 와일드카드가 필요하다.
      server.use(http.post('*/api/ws-ticket', () => HttpResponse.error()));
    });

    it('티켓 요청이 네트워크 실패해도 처리되지 않은 거부 없이 콘솔 에러로만 끝난다', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => render(<SeatGameClient tableId="tbl-1" seatIndex={0} />)).not.toThrow();

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
          HttpResponse.json({ message: '만료된 좌석 세션입니다.' }, { status: 403 }),
        ),
      );

      render(<SeatGameClient tableId="tbl-1" seatIndex={0} />);

      await waitFor(() => expect(screen.getByText('만료된 좌석 세션입니다.')).toBeInTheDocument());

      errorSpy.mockRestore();
    });

    it('서버가 문구를 안 주면 기본 안내 문구를 보여준다', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      server.use(http.post('*/api/ws-ticket', () => new HttpResponse(null, { status: 500 })));

      render(<SeatGameClient tableId="tbl-1" seatIndex={0} />);

      await waitFor(() =>
        expect(
          screen.getByText('연결이 끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요.'),
        ).toBeInTheDocument(),
      );

      errorSpy.mockRestore();
    });
  });

  // 서버는 "너 탈락했다"를 보내지 않는다. 받는 것은 renderGame과
  // REBUY_PROMPT뿐이라 프론트가 두 신호로 유추한다 — 아래 세 테스트가 그
  // 판정을 검증한다. 세 번째가 핵심: 두 트리거가 서로를 가리지 않아야 한다.
  describe('탈락 트리거', () => {
    it('리바인을 거절하면 탈락 오버레이가 뜬다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      await userEvent.click(await screen.findByRole('button', { name: /거절/ }));
      expect(await screen.findByText(/폰에서 확인/)).toBeInTheDocument();
    });

    it('내 좌석이 스냅샷에서 사라지면 탈락 오버레이가 뜬다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      const players = Array(9).fill(null);
      socket.emitServerEvent('renderGame', { ...BASE_STATE, players });
      expect(await screen.findByText(/폰에서 확인/)).toBeInTheDocument();
    });

    it('리바인 프롬프트 중에는 탈락 오버레이가 뜨지 않는다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      socket.emitServerEvent('renderGame', { ...BASE_STATE, players: Array(9).fill(null) });
      expect(screen.queryByText(/폰에서 확인/)).not.toBeInTheDocument();
    });
  });
});
