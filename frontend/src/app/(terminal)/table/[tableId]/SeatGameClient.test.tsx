import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import type { TableState } from '@/app/types/game';

// Felt는 렌더링 폭이 넓은 컴포넌트다. 이 파일이 검증하려는 건 WS 배선과
// 탈락 판정, 그리고 실패가 화면에 닿는가뿐이라 렌더만 되면 그만이다.
vi.mock('@/component/felt/Felt', () => ({ default: () => null }));

// 패널의 버튼 조건(차례·최소 레이즈)은 `SeatActionPanel.test.tsx`가 본다.
// 여기서 필요한 것은 **액션을 보내는 경로를 누를 손잡이** 하나뿐이라,
// `onAction`을 그대로 부르는 버튼으로 세운다 — 조건까지 흉내 내면 이 파일이
// 그 규칙을 두 벌째 지게 된다.
vi.mock('./SeatActionPanel', () => ({
  default: ({ onAction }: { onAction: (action: unknown) => void }) => (
    <button type="button" onClick={() => onAction({ action: 'CALL' })}>
      테스트 액션
    </button>
  ),
}));

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
  // 행사장 Wi-Fi가 끊긴 좌석 태블릿을 세우는 데 쓴다. 컴포넌트가 보는 것은
  // `readyState === WebSocket.OPEN`이라, 전역 스텁의 상수와 인스턴스의
  // `readyState`가 같은 숫자 체계여야 한다.
  static CLOSED = 3;
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
  ante: 0,
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

  /**
   * T67-1. `ws.gateway.ts`의 `handlePlayerAction`은 거절마다
   * `{ event: 'error', data }`를 **누른 사람에게만** 돌려준다. 그 프레임을
   * 안 읽으면 참가자는 눌렀는데 아무 일도 안 일어난 화면을 본다 — 상태가
   * 그대로인 거절은 화면에 다른 변화가 없어서 먹은 줄 안다.
   */
  describe('거절 프레임', () => {
    it('서버가 error 프레임을 보내면 그 문구가 화면에 뜬다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('error', '당신의 차례가 아닙니다.');

      expect(await screen.findByText('당신의 차례가 아닙니다.')).toBeInTheDocument();
    });

    it('문구가 문자열이 아니면 기본 안내로 떨어진다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('error', { message: '객체로 왔다' });

      expect(await screen.findByText('요청이 거절되었습니다.')).toBeInTheDocument();
    });

    it('확인을 눌러야 사라진다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('error', '당신의 차례가 아닙니다.');
      await screen.findByText('당신의 차례가 아닙니다.');

      await userEvent.click(screen.getByRole('button', { name: '확인' }));

      expect(screen.queryByText('당신의 차례가 아닙니다.')).not.toBeInTheDocument();
    });

    /**
     * 딜러 화면(`DealerGameClient`)은 `renderGame`이 오면 거절 문구를
     * 지운다. 좌석 화면에서 같은 짓을 하면 **남이 액션을 하는 순간** 내
     * 거절 사유가 사라진다 — `renderGame`은 테이블 전원에게 가는
     * 브로드캐스트고, 거절은 나에게만 온 ack다. 이 테스트가 그 비대칭을
     * 못 박는다.
     */
    it('남의 액션으로 renderGame이 와도 거절 사유가 지워지지 않는다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('error', '당신의 차례가 아닙니다.');
      await screen.findByText('당신의 차례가 아닙니다.');

      socket.emitServerEvent('renderGame', { ...BASE_STATE, pot: 300 });

      expect(screen.getByText('당신의 차례가 아닙니다.')).toBeInTheDocument();
    });

    it('소켓이 닫혀 있으면 액션이 전달되지 않았다는 것을 알린다', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { socket } = await renderWithSocket();
      socket.readyState = FakeSocket.CLOSED;

      await userEvent.click(screen.getByRole('button', { name: '테스트 액션' }));

      expect(await screen.findByText(/전달되지 못했습니다/)).toBeInTheDocument();
      expect(socket.sent).toHaveLength(0);
      errorSpy.mockRestore();
    });
  });

  /**
   * T67-2. 소켓이 닫혀 있어도 팝업이 닫혔다. 참가자는 **수락된 것처럼 보이는
   * 화면**을 보고, 서버는 15초 마감을 거절로 처리한다
   * (`playsync.service.ts`의 `waitForRebuyResponse`) — 성공 화면을 본 채
   * 탈락한다.
   */
  describe('리바인 응답 — 소켓이 닫혀 있을 때', () => {
    async function promptWithClosedSocket() {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000, entryFee: 50_000 });
      await screen.findByRole('button', { name: '리바인' });
      socket.readyState = FakeSocket.CLOSED;
      return { socket, errorSpy };
    }

    it('리바인을 눌러도 팝업이 닫히지 않고 실패가 보인다', async () => {
      const { socket, errorSpy } = await promptWithClosedSocket();

      await userEvent.click(screen.getByRole('button', { name: '리바인' }));

      expect(await screen.findByText(/전달되지 못했습니다/)).toBeInTheDocument();
      // 팝업이 그대로 있어야 다시 누를 수 있다.
      expect(screen.getByRole('button', { name: '리바인' })).toBeInTheDocument();
      expect(socket.sent).toHaveLength(0);
      errorSpy.mockRestore();
    });

    it('거절을 눌러도 탈락 화면으로 넘어가지 않는다', async () => {
      const { errorSpy } = await promptWithClosedSocket();

      await userEvent.click(screen.getByRole('button', { name: '거절' }));

      // 서버가 못 받은 거절로 탈락 화면을 그리면, 되돌릴 길이 화면에 없다.
      expect(screen.queryByText(/폰에서 확인/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '리바인' })).toBeInTheDocument();
      errorSpy.mockRestore();
    });

    it('소켓이 다시 열리면 리바인이 나가고 팝업이 닫힌다', async () => {
      const { socket, errorSpy } = await promptWithClosedSocket();
      await userEvent.click(screen.getByRole('button', { name: '리바인' }));
      await screen.findByText(/전달되지 못했습니다/);

      socket.readyState = FakeSocket.OPEN;
      await userEvent.click(screen.getByRole('button', { name: '리바인' }));

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '리바인' })).not.toBeInTheDocument(),
      );
      expect(socket.sent).toEqual([{ event: 'REBUY_RESPONSE', data: { accept: true } }]);
      errorSpy.mockRestore();
    });
  });
});
