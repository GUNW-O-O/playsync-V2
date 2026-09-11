import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import type { TableState } from '@playsync/contract';

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
      nickname: '나',
      seatIndex: 3,
      stack: 5000,
      bet: 0,
      hasFolded: false,
      isAllIn: false,
      hasChecked: false,
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

      // 배너는 서버 문구 뒤에 '다시 연결하는 중입니다…'를 덧붙일 수 있다(T93).
      // 정확 일치로 보면 그 덧붙임 하나에 깨지므로 서버 문구가 실렸는지만 본다.
      await waitFor(() => expect(screen.getByText(/만료된 좌석 세션입니다/)).toBeInTheDocument());

      errorSpy.mockRestore();
    });

    it('서버가 문구를 안 주면 기본 안내 문구를 보여준다', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      server.use(http.post('*/api/ws-ticket', () => new HttpResponse(null, { status: 500 })));

      render(<SeatGameClient tableId="tbl-1" seatIndex={0} />);

      await waitFor(() =>
        expect(screen.getByText(/연결이 끊어졌습니다/)).toBeInTheDocument(),
      );

      errorSpy.mockRestore();
    });
  });

  // 서버는 "너 나갔다"를 보내지 않는다. 받는 것은 renderGame과
  // REBUY_PROMPT뿐이라 프론트가 두 신호로 유추한다 — 아래 세 테스트가 그
  // 판정을 검증한다. 세 번째가 핵심: 두 트리거가 서로를 가리지 않아야 한다.
  //
  // **여기서는 덮개가 떴는지만 본다.** 어떤 문구가 뜨는지는 사유가 정하고,
  // 그것은 아래 「나온 사유」가 든다 — 문구로 덮개의 존재를 확인하면 사유가
  // 바뀔 때마다 이 셋도 같이 고쳐야 한다.
  describe('덮개 트리거', () => {
    it('리바인을 거절하면 덮개가 뜬다', async () => {
      const { socket } = await renderWithSocket();
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      await userEvent.click(await screen.findByRole('button', { name: /거절/ }));
      expect(await screen.findByRole('button', { name: /지금 돌아가기/ })).toBeInTheDocument();
    });

    it('내 좌석이 스냅샷에서 사라지면 덮개가 뜬다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      const players = Array(9).fill(null);
      socket.emitServerEvent('renderGame', { ...BASE_STATE, players });
      expect(await screen.findByRole('button', { name: /지금 돌아가기/ })).toBeInTheDocument();
    });

    it('리바인 프롬프트 중에는 덮개가 뜨지 않는다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      socket.emitServerEvent('renderGame', { ...BASE_STATE, players: Array(9).fill(null) });
      expect(screen.queryByRole('button', { name: /지금 돌아가기/ })).not.toBeInTheDocument();
    });
  });

  /**
   * **왜 떴는지가 화면에 적혀야 한다.**
   *
   * 좌석이 사라지는 계기가 둘인데 서버는 어느 쪽인지 말해 주지 않는다 —
   * 둘 다 `renderGame`의 내 자리가 `null`로만 온다. 그런데 사람에게
   * 일어난 일은 정반대다: 탈락은 대회가 끝난 것이고, 좌석 해제는 **칩을
   * 든 채 다른 자리로 걸어가는 것**이다(T29).
   *
   * 화면이 아는 것으로 가른다. 리바인 프롬프트는 칩이 0이 됐을 때만 오므로,
   * **그것을 본 적이 있으면 탈락**이고 없으면 좌석 해제다.
   *
   * 아래 둘은 **서로 갈리는 입력**이다. 같은 방향만 먹이면 판정을 통째로
   * 지워도 둘 다 초록이 된다(T29에서 실제로 그랬다).
   */
  describe('나온 사유', () => {
    it('리바인 프롬프트를 본 뒤 좌석이 사라지면 탈락으로 적는다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      socket.emitServerEvent('REBUY_PROMPT', { deadline: Date.now() + 30_000 });
      await userEvent.click(await screen.findByRole('button', { name: /거절/ }));
      expect(await screen.findByText(/칩이 0이 되어/)).toBeInTheDocument();
      expect(screen.queryByText(/자리를 이동해 주세요/)).not.toBeInTheDocument();
    });

    it('프롬프트 없이 좌석만 사라지면 자리 이동으로 적는다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });
      socket.emitServerEvent('renderGame', { ...BASE_STATE, players: Array(9).fill(null) });
      expect(await screen.findByText(/자리를 이동해 주세요/)).toBeInTheDocument();
      expect(screen.queryByText(/칩이 0이 되어/)).not.toBeInTheDocument();
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

  /**
   * **기다리는 쪽에도 설명이 있어야 한다.**
   *
   * 리바인을 묻는 팝업은 파산한 **본인에게만** 간다(`sendToTableUser`). 같은
   * 테이블의 나머지는 왜 판이 멈췄는지 모른 채 마지막 펠트를 들고 있었다.
   */
  describe('남이 리바인을 고민하는 동안', () => {
    const waiting = {
      ...BASE_STATE,
      rebuyPending: { seatIndexes: [5], deadline: Date.now() + 15_000 },
    };

    it('무엇을 기다리는지 적는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('renderGame', waiting);

      expect(screen.getByTestId('rebuy-pending')).toHaveTextContent('리바인');
    });

    /**
     * **내가 답할 차례면 그쪽이 먼저다.** 팝업을 받은 사람에게 배너까지 겹치면
     * 같은 말이 두 번이고, 정작 눌러야 할 버튼에서 눈이 갈린다.
     */
    it('내가 묻는 대상이면 배너 대신 팝업만 뜬다', async () => {
      const { socket } = await renderWithSocket({ seatIndex: 3 });

      socket.emitServerEvent('REBUY_PROMPT', {
        deadline: Date.now() + 15_000,
        userPoints: { points: 50_000 },
        entryFee: 10_000,
        tournamentName: '테스트 대회',
      });
      socket.emitServerEvent('renderGame', {
        ...BASE_STATE,
        rebuyPending: { seatIndexes: [3], deadline: Date.now() + 15_000 },
      });

      expect(screen.getByRole('button', { name: '리바인' })).toBeInTheDocument();
      expect(screen.queryByTestId('rebuy-pending')).toBeNull();
    });

    it('기다림이 끝나면 사라진다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('renderGame', waiting);
      socket.emitServerEvent('renderGame', BASE_STATE);

      expect(screen.queryByTestId('rebuy-pending')).toBeNull();
    });
  });

  /**
   * **좌석도 같은 구멍이었다.** 대회를 닫는 경로가 소켓에 아무것도 쓰지 않아서
   * 이 태블릿은 끝난 대회의 마지막 스냅샷을 계속 그렸다. 탈락한 사람은
   * `EliminatedOverlay`가 덮어 주지만, **끝까지 남아 상금을 받은 사람은 그
   * 덮개가 안 뜬다** — 우승자가 앉은 자리가 다음 손님을 못 받는다.
   */
  describe('대회가 닫히면', () => {
    const CLOSED = { tournamentId: 'trn-1', status: 'FINISHED' as const, closedAt: 1 };

    it('덮개가 뜬다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('tournamentClosed', CLOSED);

      expect(screen.getByTestId('seat-tournament-closed')).toHaveTextContent('대회가 끝났습니다');
    });

    it('중단이면 환불이라고 적는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('tournamentClosed', { ...CLOSED, status: 'CANCELLED' });

      expect(screen.getByTestId('seat-tournament-closed')).toHaveTextContent('중단');
    });

    /**
     * 알림과 종료 사이에 이미 큐에 있던 프레임이 도착할 수 있다. 그것이 덮개를
     * 걷으면 끝난 대회의 펠트가 다시 나온다.
     */
    it('늦게 온 renderGame이 덮개를 걷지 않는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('tournamentClosed', CLOSED);
      socket.emitServerEvent('renderGame', BASE_STATE);

      expect(screen.getByTestId('seat-tournament-closed')).toBeInTheDocument();
    });

    /**
     * **서버가 알린 뒤 소켓을 닫는다**(`WsGateway.closeTable`). 코드 1000이라
     * `onclose`가 그대로 넘어가고, 화면에는 종료 덮개만 남아야 한다.
     */
    it('서버가 소켓을 닫아도 덮개만 남는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('tournamentClosed', CLOSED);
      act(() => socket.close());

      const banner = screen.queryByText(/연결이 끊어졌습니다/);
      const closed = screen.queryByTestId('seat-tournament-closed');
      expect(`배너 ${banner ? '있음' : '없음'} / 덮개 ${closed ? '있음' : '없음'}`)
        .toBe('배너 없음 / 덮개 있음');
    });
  });

  /**
   * **끊기면 스스로 돌아온다**(T93).
   *
   * 예전에는 `onclose`가 문구만 세우고 끝났고, effect 의존성이 테이블 id라
   * 다시 돌지도 않았다 — 서버를 재시작하면 행사장의 태블릿 전부가 에러
   * 화면에서 멈추고 사람이 한 대씩 새로고침해야 했다.
   */
  describe('자동 재접속', () => {
    /** 지터를 0으로 고정한다 — 최대 40초를 실제로 기다리지 않는다. */
    function noJitter() {
      return vi.spyOn(Math, 'random').mockReturnValue(0);
    }

    it('소켓이 끊기면 새 소켓을 연다', async () => {
      const rand = noJitter();
      const { socket } = await renderWithSocket();

      // 1006은 브라우저가 비정상 종료에 쓰는 코드다 — 서버가 사라진 경우.
      act(() => socket.onclose?.({ code: 1006, reason: '' }));

      await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
      rand.mockRestore();
    });

    /**
     * **반대 입력.** 코드 1000은 서버가 정상적으로 닫은 것이고, 대회가 끝나
     * 닫힌 경우가 그것이다. 다시 붙으면 끝난 대회에 계속 매달린다 — 이 검사가
     * 없으면 "항상 다시 붙는다"는 구현도 위 검사를 통과한다.
     */
    it('정상 종료(1000)에는 다시 붙지 않는다', async () => {
      const rand = noJitter();
      const { socket } = await renderWithSocket();

      act(() => socket.onclose?.({ code: 1000, reason: '' }));

      // 다시 붙었다면 이 사이에 인스턴스가 늘어난다.
      await new Promise((r) => setTimeout(r, 30));
      expect(FakeSocket.instances.length).toBe(1);
      rand.mockRestore();
    });

    /**
     * 배너가 "새로고침하라"에서 "기다리면 낫는다"로 바뀌어야 한다. 문구만
     * 남기면 참가자는 자기가 할 일이 있는 줄 안다.
     */
    it('다시 붙는 동안 그 사실을 배너에 적는다', async () => {
      const rand = noJitter();
      const { socket } = await renderWithSocket();

      act(() => socket.onclose?.({ code: 1006, reason: '' }));

      await waitFor(() =>
        expect(screen.getByText(/다시 연결하는 중입니다/)).toBeInTheDocument(),
      );
      rand.mockRestore();
    });

    /**
     * **성공의 정의가 "열렸다"가 아니라 "첫 프레임이 왔다"다.** 그 프레임이
     * 곧 "열렸고 등록됐다"의 증거다(`WsGateway.handleConnection`). 프레임이
     * 오면 배너가 사라져야 한다.
     */
    it('첫 프레임이 오면 배너가 사라진다', async () => {
      const rand = noJitter();
      const { socket } = await renderWithSocket();

      act(() => socket.onclose?.({ code: 1006, reason: '' }));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2));

      FakeSocket.instances[1].emitServerEvent('renderGame', BASE_STATE);

      expect(screen.queryByText(/연결이 끊어졌습니다/)).toBeNull();
      rand.mockRestore();
    });
  });

  /**
   * 정지 안내(T95). 이 화면을 보는 사람은 방금 재접속한 사람이다 — 첫 프레임에
   * 정지 표시가 실려 있으면 **기다릴 대상**을 적어야 한다. 안 적으면 참가자는
   * 자기 차례가 멈춘 이유를 모른 채 버튼을 누르고 서버가 거절한다.
   */
  describe('정지 안내', () => {
    it('정지 표시가 오면 멈춘 길이와 기다릴 대상을 적는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('renderGame', { ...BASE_STATE, resumePending: { downMs: 192_000 } });

      const banner = screen.getByTestId('seat-resume-wait');
      expect(banner).toHaveTextContent('3분 12초');
      expect(banner).toHaveTextContent('딜러');
    });

    /** **반대 입력.** 멈추지 않은 판에 이 안내가 뜨면 참가자가 손을 멈춘다. */
    it('멈추지 않았으면 뜨지 않는다', async () => {
      const { socket } = await renderWithSocket();

      socket.emitServerEvent('renderGame', BASE_STATE);

      expect(screen.queryByTestId('seat-resume-wait')).toBeNull();
    });
  });
});
