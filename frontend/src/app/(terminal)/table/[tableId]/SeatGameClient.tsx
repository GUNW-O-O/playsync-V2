'use client';

import { useEffect, useRef, useState } from 'react';
import { PlayerAction } from '@playsync/contract';
import Felt from '@/component/felt/Felt';
import { apiFetch } from '@/lib/api';
import { TableState } from '@/app/types/game';
import SeatActionPanel from './SeatActionPanel';
import RebuyOverlay, { type RebuyPrompt } from './RebuyOverlay';
import EliminatedOverlay from './EliminatedOverlay';

// 서버·소켓이 문구를 안 줄 때의 최후 안내. WS 배선(티켓 요청·정리·배너)은
// 옛 GameClient에서 그대로 옮겨 왔다 — T24가 세운 규칙이고, 액세스 토큰이
// 이 컴포넌트에 들어오지 않는 구조를 다시 설계하지 않는다.
const DEFAULT_CONNECTION_ERROR = '연결이 끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요.';

/** 서버가 `error` 프레임에 문자열을 안 실어 줬을 때의 최후 안내. */
const DEFAULT_ACTION_ERROR = '요청이 거절되었습니다.';

/**
 * 보내려 했는데 소켓이 열려 있지 않았을 때. **서버가 거절한 것이 아니라
 * 애초에 닿지 않은 것**이라 문구가 다르다 — 거절은 이유가 있고, 이쪽은
 * 다시 눌러 보라는 것 말고 할 말이 없다.
 */
const NOT_SENT_ERROR = '연결이 끊어져 전달되지 못했습니다. 잠시 후 다시 눌러 주세요.';

/** 좌석 화면 상단 바 · 사이드 패널에 쓰는 페이즈 한글 이름. */
const PHASE_LABEL: Record<number, string> = {
  0: '대기',
  1: '프리플랍',
  2: '플랍',
  3: '턴',
  4: '리버',
  5: '쇼다운',
  6: '핸드 종료',
};

/**
 * 좌석에 앉은 참가자가 앉아 있는 동안 보는 유일한 화면(와이어프레임
 * 724–845행). 딜러 분기가 없다 — 딜러 화면은 별도 컴포넌트(다음 태스크)다.
 *
 * 탈락은 서버가 알려주지 않는다. 받는 이벤트는 `renderGame`과
 * `REBUY_PROMPT` 둘뿐이라 두 신호로 유추한다.
 *   (a) 리바인 프롬프트에 거절을 보낸 직후
 *   (b) 프롬프트가 없는 상태에서 `renderGame`의 내 좌석이 `null`
 * (b)는 리바인 프롬프트가 떠 있는 동안에는 판정하지 않는다 — 실제로 그
 * 구간에 좌석이 비는 것은 아니다. 좌석을 `null`로 만드는 것은
 * `table-engine.ts`의 `initTable` 하나뿐이고, 그건 리바인 대기·탈락 확정이
 * 끝난 **뒤**(`dealer.service.ts`)에 돈다. 그래도 가드를 두는 것은 값싼
 * 방어다 — 프롬프트가 떠 있는 동안은 애초에 탈락을 판정할 필요가 없는
 * 시점이라, 검사 하나로 그 창을 통째로 걸러 둔다. `rebuyDataRef`로 최신
 * 값을 보는 이유는: `onmessage`는 최초 연결 시 한 번만 만들어지는 클로저라,
 * 상태 변수를 직접 읽으면 그 시점의 값(대개 초기값)에 갇힌다.
 */
export default function SeatGameClient({
  tableId,
  initialData,
  seatIndex,
  storeId,
  tableOrder,
}: {
  tableId: string;
  initialData?: TableState;
  seatIndex: number;
  storeId?: string;
  /** 눈앞의 테이블에 붙은 번호. 없으면 머리글에서 테이블을 뺀다. */
  tableOrder?: number;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const mySeatIndex: number | null = seatIndex ?? null;
  const [rebuyData, setRebuyData] = useState<RebuyPrompt | null>(null);
  const rebuyDataRef = useRef<RebuyPrompt | null>(null);
  const [eliminated, setEliminated] = useState(false);
  /*
    실패가 갈래 둘이고, 참가자가 할 수 있는 일이 다르다.

    - `connectionError` — **저절로 낫는 것.** 참가자가 지울 수 있는 것이
      아니라 위쪽 띠로 남긴다. 화면을 덮으면 다시 붙은 뒤에도 가린다.
    - `actionError` — **읽고 지워야 하는 것.** 눌렀는데 안 먹은 사건이라
      확인을 받아야 다음 조작으로 넘어간다. 딜러 화면
      (`DealerGameClient`)이 거절 모달과 연결 끊김 배너를 가른 것과 같은
      자리다.

    좌석 화면에는 셋째가 있다 — 리바인 실패(`rebuyError`)다. 팝업 위에
    모달을 또 얹으면 정작 다시 눌러야 할 버튼을 가리므로, 그 실패는
    `RebuyOverlay` **안에** 그린다.
  */
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rebuyError, setRebuyError] = useState<string | null>(null);

  function updateRebuyData(next: RebuyPrompt | null) {
    rebuyDataRef.current = next;
    setRebuyData(next);
  }

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;

    // 티켓은 1회용 30초라 연결 시도마다 새로 받는다. 액세스 토큰은 이 컴포넌트에
    // 들어오지 않는다 — 쿠키를 읽는 것은 route handler(서버)뿐이다.
    //
    // fetch 자체가 reject하는 경우(네트워크 단절, 브라우저 확장 차단 등)를
    // try/catch로 감싼다. 감싸지 않으면 이 async IIFE는 어디서도 await되지
    // 않으므로 처리되지 않은 프라미스 거부로 새어 나간다. res.json() 파싱
    // 실패도 같은 자리에서 잡힌다.
    (async () => {
      try {
        const res = await apiFetch('/api/ws-ticket', { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const message = (body as { message?: unknown } | null)?.message;
          console.error('WS 티켓을 받지 못했습니다.');
          if (!cancelled) {
            setConnectionError(typeof message === 'string' && message ? message : DEFAULT_CONNECTION_ERROR);
          }
          return;
        }
        const { ticket } = await res.json();
        if (cancelled) return;

        const wsUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL?.replace('http', 'ws')}/playsync?tableId=${tableId}&ticket=${ticket}`;
        socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.onmessage = (event) => {
          const { event: serverEvent, data } = JSON.parse(event.data);
          if (serverEvent === 'renderGame') {
            setGameState(data);
            // 탈락 판정 (b): 리바인 프롬프트가 떠 있는 동안에는 좌석 소멸을
            // 탈락으로 보지 않는다 — 리바인 구간에도 좌석이 잠깐 빈다.
            if (!rebuyDataRef.current && mySeatIndex !== null && data.players[mySeatIndex] === null) {
              setEliminated(true);
            }
          } else if (serverEvent === 'REBUY_PROMPT') {
            setRebuyError(null);
            updateRebuyData(data);
          } else if (serverEvent === 'error') {
            // 거절은 브로드캐스트가 아니라 **누른 사람에게만** 오는 ack다
            // (`ws.gateway.ts`의 `handlePlayerAction`). 안 읽으면 참가자는
            // 눌렀는데 아무 변화도 없는 화면을 보고 먹은 줄 안다.
            //
            // **`renderGame`으로 지우지 않는다.** 딜러 화면은 그렇게 하지만
            // (`DealerGameClient`), 좌석 화면에서 `renderGame`은 남이 액션할
            // 때마다 오는 브로드캐스트라 — 내 거절 사유가 1초도 못 버틴다.
            setActionError(typeof data === 'string' && data ? data : DEFAULT_ACTION_ERROR);
          }
        };

        socket.onclose = (event) => {
          // cleanup(언마운트)이 socket.close()를 부르면 이 핸들러도 불린다.
          // cancelled로 그 정상 종료를 구분한다. 코드 1000(정상 종료)도
          // 에러로 보지 않는다.
          if (cancelled || event.code === 1000) return;
          setConnectionError(event.reason && event.reason.trim() ? event.reason : DEFAULT_CONNECTION_ERROR);
        };

        socket.onerror = () => {
          if (cancelled) return;
          setConnectionError(DEFAULT_CONNECTION_ERROR);
        };
      } catch (err) {
        // 언마운트로 인한 중단(cancelled)은 정상 경로다. 에러처럼 남기지 않는다.
        if (!cancelled) {
          console.error('WS 티켓 요청 중 오류가 발생했습니다.', err);
          setConnectionError(DEFAULT_CONNECTION_ERROR);
        }
      }
    })();

    return () => {
      cancelled = true;
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, seatIndex]);

  /**
   * 소켓이 열려 있으면 보내고 `true`, 아니면 아무것도 안 보내고 `false`.
   *
   * **보냈는가를 호출자가 알아야 한다.** 예전에는 두 자리 다 `else`에서
   * `console.error` 한 줄만 남기고 화면은 성공한 것처럼 넘어갔다 — 참가자는
   * 콘솔을 볼 수 없다.
   */
  function trySend(event: string, data: unknown): boolean {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      console.error('웹소켓 연결이 열려있지 않습니다.');
      return false;
    }
    socketRef.current.send(JSON.stringify({ event, data }));
    return true;
  }

  function sendPlayerAction(action: PlayerAction) {
    // token과 tableId는 싣지 않는다. 서버는 둘 다 읽지 않는다 — 핸드셰이크에서
    // 이미 검증해 소켓에 박아 두었다. 인바운드 스키마(.strict())가 모르는
    // 키로 거부한다.
    if (!trySend('PLAYER_ACTION', action)) {
      setActionError(NOT_SENT_ERROR);
    }
  }

  function handleRebuyResponse(accept: boolean) {
    // **못 보냈으면 팝업을 닫지 않는다.** 닫으면 화면은 수락된 것처럼
    // 보이는데 서버는 15초 마감을 거절로 처리한다
    // (`playsync.service.ts`의 `waitForRebuyResponse`) — 참가자가 성공
    // 화면을 본 채 탈락한다. 거절도 같다: 서버가 못 받은 거절로 탈락
    // 화면을 그리면 되돌릴 길이 화면에 없다.
    if (!trySend('REBUY_RESPONSE', { accept })) {
      setRebuyError(NOT_SENT_ERROR);
      return;
    }
    setRebuyError(null);
    updateRebuyData(null);
    // 탈락 판정 (a): 리바인 거절을 보낸 직후. 서버 응답을 기다리지 않는다 —
    // 거절은 이미 확정된 의사고, 잃는 것은 화면 전환 타이밍뿐이다.
    if (!accept) {
      setEliminated(true);
    }
  }

  const myPlayer = gameState && mySeatIndex !== null ? (gameState.players[mySeatIndex] ?? null) : null;
  // 낸 금액·콜·최소 레이즈는 Felt의 좌석 카드엔 없는 값이다 — 펠트는 베팅액과
  // 올인 여부만 그린다(리뷰 지적: 이걸 근거 없이 "중복"으로 보고 뺐었다).
  const betPlaced = myPlayer?.bet ?? 0;
  const toCall = gameState ? Math.max(0, gameState.currentBet - betPlaced) : 0;
  const minRaise = gameState ? gameState.currentBet + gameState.smallBlind * 2 : 0;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-tb-bg text-tb-ink">
      {connectionError && (
        <div className="absolute inset-x-0 top-0 z-50 bg-err px-4 py-2 text-center text-sm font-medium text-white">
          {connectionError}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between border-b border-tb-line bg-tb-panel px-4 py-2 text-xs text-tb-sub">
        {/*
          예전에는 여기에 `tableId`(UUID)가 그대로 떴다. 앉은 사람에게는
          아무 의미가 없고, 눈앞의 테이블에 붙어 있는 것은 번호다. 번호를
          못 구했으면 테이블 쪽을 통째로 뺀다 — UUID로 되돌아가지 않는다.
        */}
        <span>
          {[
            tableOrder !== undefined ? `${tableOrder}번 테이블` : null,
            mySeatIndex !== null ? `${mySeatIndex + 1}번 자리` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span>
          {gameState
            ? `${gameState.smallBlind.toLocaleString()} / ${(gameState.smallBlind * 2).toLocaleString()}`
            : '대기 중'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center p-3">
          <Felt state={gameState} orientation="player" mySeatIndex={mySeatIndex} />
        </div>

        <div className="flex w-[232px] shrink-0 flex-col gap-2.5 overflow-hidden border-l border-tb-line bg-tb-panel p-3">
          <div className="border border-tb-line bg-tb-bg p-2.5">
            <p className="text-[11px] tracking-[0.06em] text-tb-sub">지금</p>
            <div className="text-lg font-light text-tb-ink">{PHASE_LABEL[gameState?.phase ?? 0]}</div>
          </div>

          <div>
            <p className="text-[11px] tracking-[0.06em] text-tb-sub">내 스택</p>
            <div className="text-2xl font-light text-tb-ink">{(myPlayer?.stack ?? 0).toLocaleString()}</div>
          </div>

          <div className="border-t border-tb-line" />

          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-tb-muted">낸 금액</span>
              <span className="font-mono text-tb-ink">{betPlaced.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-tb-muted">콜</span>
              <span className="font-mono text-tb-ink">{toCall.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-tb-muted">최소 레이즈</span>
              <span className="font-mono text-tb-ink">{minRaise.toLocaleString()}</span>
            </div>
          </div>

          <div className="border-t border-tb-line" />

          <div className="flex items-center justify-between text-xs">
            <span className="text-tb-muted">차례</span>
            <span className="text-tb-ink">
              {gameState && gameState.currentTurnSeatIndex >= 0
                ? `${gameState.currentTurnSeatIndex + 1}번 자리`
                : '—'}
            </span>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-tb-line p-3">
        <SeatActionPanel state={gameState} mySeatIndex={mySeatIndex} onAction={sendPlayerAction} />
      </div>

      {/*
        **거절은 참가자가 읽고 지워야 한다.** 위쪽 띠로 걸어 두면 펠트를
        보는 눈이 지나친다 — 상태가 그대로인 거절(차례가 아니다, 최소
        레이즈에 못 미친다)은 화면에 다른 변화가 없어서, 못 보면 먹은 줄
        알고 그대로 시간이 흘러 자동 폴드된다. 연결 끊김(위 배너)은 반대로
        참가자가 지울 수 있는 것이 아니라 배너로 남긴다.

        리바인 팝업이 떠 있는 동안은 그리지 않는다 — 그 실패는 팝업 안에
        그리고(`rebuyError`), 여기 모달이 겹치면 다시 눌러야 할 버튼을 가린다.
      */}
      {actionError && !rebuyData && (
        <div
          data-testid="seat-action-error"
          role="alertdialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6"
        >
          <div className="w-full max-w-[430px] border border-err bg-tb-panel p-6">
            <p className="text-xs tracking-[0.14em] text-err">이 요청은 처리되지 않았습니다</p>
            <div className="mb-1.5 mt-2 text-xl font-light leading-snug text-tb-ink">
              {actionError}
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="border border-tb-act bg-tb-act px-5 py-2.5 text-sm font-semibold text-[#06201a]"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {rebuyData && (
        <RebuyOverlay rebuyData={rebuyData} error={rebuyError} onRespond={handleRebuyResponse} />
      )}
      {eliminated && <EliminatedOverlay storeId={storeId} />}
    </div>
  );
}
