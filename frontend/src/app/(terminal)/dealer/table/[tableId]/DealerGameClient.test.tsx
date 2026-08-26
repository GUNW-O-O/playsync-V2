import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { GamePhase, type TableState } from '@playsync/contract';

// 종료 덮개가 대기 화면으로 돌아간다(`TournamentClosedOverlay`). 좌석 쪽
// `SeatGameClient.test.tsx`와 같은 배선이다.
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const DealerGameClient = (await import('./DealerGameClient')).default;

/**
 * `SeatGameClient.test.tsx`의 FakeSocket을 그대로 가져왔다. `emitServerEvent`를
 * `act()`로 감싸는 이유도 같다 — WebSocket 콜백은 React 이벤트가 아니라 act가
 * 추적하지 않는다. 감싸지 않으면 커밋이 다음 마이크로태스크로 밀려, 그 직후의
 * 동기 단언이 갱신 전 DOM을 본다(리뷰 지적: Task 3에서 이 가드가 빠진 테스트
 * 하나가 통과했던 이유).
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

  emitServerEvent(event: string, data: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify({ event, data }) });
    });
  }
}

function tablePlayer(overrides: Partial<NonNullable<TableState['players'][number]>> = {}) {
  return {
    id: 'u-3',
    nickname: 'player-3',
    seatIndex: 3,
    stack: 5000,
    bet: 0,
    hasFolded: false,
    isAllIn: false,
    hasChecked: false,
    totalContributed: 0,
    ...overrides,
  };
}

function baseState(overrides: Partial<TableState> = {}): TableState {
  return {
    phase: GamePhase.WAITING,
    players: [null, null, null, tablePlayer(), null, null, null, null, null],
    buttonUser: 3,
    currentTurnSeatIndex: -1,
    pot: 0,
    sidePots: [],
    currentBet: 0,
    smallBlind: 100,
    ante: 0,
    tournamentId: 'trn-1',
    ...overrides,
  };
}

/** WS 배선을 세우고 소켓 인스턴스가 만들어질 때까지 기다린다. */
async function renderWithSocket(initialData: TableState, props: { tableOrder?: number } = {}) {
  FakeSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  server.use(http.post('*/api/ws-ticket', () => HttpResponse.json({ ticket: 'tkt-1' })));

  render(<DealerGameClient tableId="tbl-1" initialData={initialData} {...props} />);

  await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
  return { socket: FakeSocket.instances[0] };
}

describe('DealerGameClient', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  // 두 단언이 서로 가리지 않게 phase 둘을 각각 먹인다 — 한 phase만 검증하면
  // "항상 활성/항상 비활성"인 게이팅도 통과해 버린다.
  describe('phase 게이팅', () => {
    it('WAITING에서는 핸드 시작이 눌리고 승자 결정은 안 눌린다', async () => {
      await renderWithSocket(baseState({ phase: GamePhase.WAITING }));

      expect(screen.getByRole('button', { name: '핸드 시작' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: '승자 결정' })).toBeDisabled();
    });

    it('SHOWDOWN에서는 승자 결정이 눌리고 핸드 시작은 안 눌린다', async () => {
      await renderWithSocket(baseState({ phase: GamePhase.SHOWDOWN }));

      expect(screen.getByRole('button', { name: '승자 결정' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: '핸드 시작' })).toBeDisabled();
    });
  });

  /**
   * 백엔드는 체크포인트가 재시도까지 실패한 상태를 안전 상태로 두고 나올 길을
   * 만들어 뒀다(`DealerService.retryCheckpoint`). 화면에 그 길이 없으면 딜러는
   * `HAND_END`에서 아무 버튼도 안 켜진 테이블 앞에 남는다 — `canStartHand`가
   * `phase === WAITING`이라서다.
   */
  describe('체크포인트 탈출구', () => {
    it('저장이 실패하면 핸드 시작 자리가 저장 재시도로 바뀐다', async () => {
      await renderWithSocket(
        baseState({ phase: GamePhase.HAND_END, dbSyncStatus: 'FAILED' }),
      );

      expect(screen.getByRole('button', { name: '저장 재시도' })).not.toBeDisabled();
      expect(screen.queryByRole('button', { name: '핸드 시작' })).toBeNull();
    });

    it('왜 멈췄는지 화면에 적는다', async () => {
      await renderWithSocket(
        baseState({ phase: GamePhase.HAND_END, dbSyncStatus: 'FAILED' }),
      );

      expect(screen.getByTestId('db-sync-status')).toHaveTextContent('저장 실패');
    });

    it('서버가 재시도 중이면 누르지 못한다', async () => {
      // 이미 백엔드가 재시도를 돌리고 있다. 딜러가 겹쳐 누를 이유가 없다.
      await renderWithSocket(
        baseState({ phase: GamePhase.HAND_END, dbSyncStatus: 'RETRYING' }),
      );

      expect(screen.getByRole('button', { name: '저장 재시도' })).toBeDisabled();
    });

    it('저장이 멀쩡하면 탈출구를 띄우지 않는다', async () => {
      // 이 단언이 없으면 "항상 재시도 버튼"인 구현도 위 셋을 통과한다.
      await renderWithSocket(baseState({ phase: GamePhase.HAND_END }));

      expect(screen.queryByRole('button', { name: '저장 재시도' })).toBeNull();
      expect(screen.queryByTestId('db-sync-status')).toBeNull();
      expect(screen.getByRole('button', { name: '핸드 시작' })).toBeInTheDocument();
    });

    it('누르면 RETRY_CHECKPOINT가 다른 키 없이 그대로 나간다', async () => {
      const { socket } = await renderWithSocket(
        baseState({ phase: GamePhase.HAND_END, dbSyncStatus: 'FAILED' }),
      );

      await userEvent.click(screen.getByRole('button', { name: '저장 재시도' }));

      expect(socket.sent).toEqual([
        { event: 'DEALER_ACTION', data: { action: 'RETRY_CHECKPOINT' } },
      ]);
    });
  });

  /**
   * 킥과 폴드는 다른 조작이다. 킥은 참가를 끝내고, 폴드는 이 핸드만 포기시킨다.
   * `DEALER_FOLD`가 계약에 있는데 화면에 컨트롤이 없었다.
   */
  describe('딜러 폴드', () => {
    it('베팅 중이면 그 자리를 접을 수 있다', async () => {
      const { socket } = await renderWithSocket(
        baseState({ phase: GamePhase.FLOP, currentTurnSeatIndex: 3 }),
      );

      await userEvent.click(screen.getByTestId('seat-3'));
      await userEvent.click(screen.getByTestId('confirm-fold'));

      expect(socket.sent).toEqual([
        { event: 'DEALER_ACTION', data: { action: 'DEALER_FOLD', targetUserId: 'u-3' } },
      ]);
    });

    it('베팅 라운드가 아니면 누르지 못한다', async () => {
      // 엔진이 베팅 페이즈가 아닌 액션을 던진다(`TableEngine.act`). 거절을
      // 받고 나서 알 이유가 없다.
      await renderWithSocket(baseState({ phase: GamePhase.WAITING }));

      await userEvent.click(screen.getByTestId('seat-3'));

      expect(screen.getByTestId('confirm-fold')).toBeDisabled();
    });
  });

  it('자리를 누르고 내보내기를 확인하면 DEALER_KICK이 토큰·tableId 없이 그대로 나간다', async () => {
    const { socket } = await renderWithSocket(baseState());

    await userEvent.click(screen.getByTestId('seat-3'));
    await userEvent.click(screen.getByTestId('confirm-kick'));

    // 인바운드 스키마(`packages/contract/src/dealer-action.ts`)가 .strict()라
    // 키 하나만 더 실려도 서버가 통째로 거부한다. 본문을 통째로 단언해
    // 토큰·tableId가 안 실린 것까지 같이 본다 — 핸드셰이크에서 이미 검증돼
    // 소켓에 박혀 있어 페이로드에 실을 필요가 없다.
    expect(socket.sent).toEqual([
      { event: 'DEALER_ACTION', data: { action: 'DEALER_KICK', targetUserId: 'u-3' } },
    ]);
  });

  /**
   * 좌석 태블릿에서 이미 한 번 걷어낸 것과 같은 결함이다(B2). 딜러에게도
   * uuid는 아무 의미가 없고, 눈앞의 테이블에 붙어 있는 것은 번호다.
   */
  describe('머리글', () => {
    it('테이블 번호를 받으면 uuid 대신 번호를 쓴다', async () => {
      await renderWithSocket(baseState(), { tableOrder: 2 });

      // 펠트에도 딜러 표찰이 있다(`Felt`의 12시). 머리글만 본다.
      expect(screen.getByTestId('dealer-header')).toHaveTextContent('2번 테이블 · 딜러');
      expect(screen.queryByText(/tbl-1/)).toBeNull();
    });

    it('번호를 못 구했으면 테이블 쪽을 통째로 뺀다', async () => {
      // uuid로 되돌아가지 않는다. 못 구한 번호 자리에 uuid를 넣으면 이
      // 결함이 그대로 살아 있는 것과 같다.
      await renderWithSocket(baseState());

      expect(screen.getByTestId('dealer-header')).toHaveTextContent('딜러');
      expect(screen.getByTestId('dealer-header')).not.toHaveTextContent('테이블');
      expect(screen.queryByText(/tbl-1/)).toBeNull();
    });
  });

  /**
   * 서버는 거절을 브로드캐스트하지 않고 **누른 사람에게만** ack로 돌려준다
   * (`ws.gateway.ts`의 `return { event: 'error', data: e.message }`). 그 이벤트를
   * 읽지 않으면 딜러 화면에서 실패와 성공이 구분되지 않는다 — 승자 결정처럼
   * 상태가 그대로인 거절은 화면에 아무 변화도 남기지 않기 때문이다.
   */
  describe('거절 ack', () => {
    it('error 이벤트의 사유를 화면에 띄운다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.SHOWDOWN }));

      socket.emitServerEvent('error', '지명되지 않은 팟이 있습니다.');

      expect(screen.getByTestId('dealer-action-error')).toHaveTextContent(
        '지명되지 않은 팟이 있습니다.',
      );
    });

    it('확인을 누르면 사유가 닫힌다', async () => {
      // 거절은 **딜러가 읽고 지워야 하는 것**이다. 배너로 위에 걸어 두면
      // 카메라 앞에서도, 테이블 앞에서도 지나칠 수 있다 — 실제로 첫
      // 촬영본에서 무엇이 거절됐는지 알아보기 어려웠다.
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.SHOWDOWN }));

      socket.emitServerEvent('error', '지명되지 않은 팟이 있습니다.');
      await userEvent.click(screen.getByRole('button', { name: '확인' }));

      expect(screen.queryByTestId('dealer-action-error')).toBeNull();
    });

    it('다음 renderGame이 오면 사유를 걷는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.SHOWDOWN }));

      socket.emitServerEvent('error', '지명되지 않은 팟이 있습니다.');
      socket.emitServerEvent('renderGame', baseState({ phase: GamePhase.WAITING }));

      expect(screen.queryByTestId('dealer-action-error')).toBeNull();
    });
  });

  /**
   * **대회가 닫히면 그 사실이 화면에 있어야 한다.**
   *
   * 이 알림이 없는 동안 딜러 화면은 마지막 스냅샷을 계속 그렸다. 그 상태에서
   * 무엇을 누르든 `Table` 행도 스냅샷도 없어 돌아오는 것은 「명령이
   * 거절되었습니다」뿐이었다 — 끝났다는 사실이 아니라 정체불명의 에러다.
   */
  describe('대회가 닫히면', () => {
    const CLOSED = { tournamentId: 'trn-1', status: 'FINISHED' as const, closedAt: 1 };

    it('덮개가 뜨고 종료라고 적는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.HAND_END }));

      socket.emitServerEvent('tournamentClosed', CLOSED);

      expect(screen.getByTestId('dealer-tournament-closed')).toHaveTextContent('대회가 끝났습니다');
    });

    /**
     * **종료와 중단은 다른 문장이다.** 종료는 걷은 돈이 상금과 상점 몫으로
     * 다 나간 것이고, 중단은 환불하고 무른 것이다. 같은 문구로 덮으면 딜러가
     * 참가자에게 무엇을 안내해야 하는지가 화면에서 사라진다.
     */
    it('중단이면 환불이라고 적는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.HAND_END }));

      socket.emitServerEvent('tournamentClosed', { ...CLOSED, status: 'CANCELLED' });

      expect(screen.getByTestId('dealer-tournament-closed')).toHaveTextContent('중단');
    });

    /**
     * **덮개가 조작을 가린다.** 끝난 대회의 「핸드 시작」은 거절만 부른다.
     * 버튼을 비활성으로 두는 것으로는 부족하다 — 딜러가 보는 것은 펠트이고,
     * 왜 안 눌리는지가 어디에도 안 적힌다.
     */
    it('덮개 아래의 조작은 닿지 않는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.WAITING }));
      expect(screen.getByRole('button', { name: '핸드 시작' })).not.toBeDisabled();

      socket.emitServerEvent('tournamentClosed', CLOSED);

      expect(screen.getByRole('button', { name: '핸드 시작' })).toBeDisabled();
    });

    /**
     * **닫힌 뒤의 renderGame이 덮개를 걷지 않는다.** 서버가 소켓을 끊지 않으므로
     * 늦게 도착한 프레임이 있을 수 있고, 그것이 덮개를 지우면 딜러는 끝난 대회의
     * 펠트를 다시 만지게 된다.
     */
    it('늦게 온 renderGame이 덮개를 걷지 않는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.HAND_END }));

      socket.emitServerEvent('tournamentClosed', CLOSED);
      socket.emitServerEvent('renderGame', baseState({ phase: GamePhase.WAITING }));

      expect(screen.getByTestId('dealer-tournament-closed')).toBeInTheDocument();
    });

    /**
     * **끝난 것과 끊긴 것은 다른 사건이다.** 연결 끊김 배너가 같이 뜨면 딜러는
     * 망을 의심하고 새로고침한다 — 그러면 대회가 끝났다는 문장도 사라진다.
     */
    it('연결 끊김 배너를 대신 그리지 않는다', async () => {
      const { socket } = await renderWithSocket(baseState({ phase: GamePhase.HAND_END }));

      socket.emitServerEvent('tournamentClosed', CLOSED);

      // **둘을 같이 본다.** 배너가 없다는 것만 보면 덮개를 통째로 지워도
      // 초록이다 — 지금 배선에서 배너는 `onclose`가 띄우고, 이 이벤트는
      // 소켓을 닫지 않기 때문이다.
      const banner = screen.queryByText(/연결이 끊어졌습니다/);
      const closed = screen.queryByTestId('dealer-tournament-closed');
      expect(`배너 ${banner ? '있음' : '없음'} / 덮개 ${closed ? '있음' : '없음'}`)
        .toBe('배너 없음 / 덮개 있음');
    });
  });
});
