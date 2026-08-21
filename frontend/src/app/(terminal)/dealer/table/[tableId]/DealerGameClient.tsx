'use client';

import { useEffect, useRef, useState } from 'react';
import { DealerAction } from '@playsync/contract';
import Felt from '@/component/felt/Felt';
import { apiFetch } from '@/lib/api';
import { GamePhase, TableState } from '@playsync/contract';
import WinnerOverlay, { type WinnerCandidate } from './WinnerOverlay';

// 서버·소켓이 문구를 안 줄 때의 최후 안내. WS 배선(티켓 요청·정리·배너)은
// `SeatGameClient`에서 그대로 옮겨 왔다 — T24가 세운 규칙이고, 액세스 토큰이
// 이 컴포넌트에 들어오지 않는 구조를 다시 설계하지 않는다.
const DEFAULT_CONNECTION_ERROR = '연결이 끊어졌습니다. 화면을 새로고침하거나 운영자에게 알려주세요.';

/** 딜러 화면 상단 바 · 상태 배지에 쓰는 페이즈 한글 이름. */
const PHASE_LABEL: Record<number, string> = {
  0: '대기',
  1: '프리플랍',
  2: '플랍',
  3: '턴',
  4: '리버',
  5: '쇼다운',
  6: '핸드 종료',
};

type KickTarget = { seatIndex: number; id: string; nickname: string };

/**
 * 딜러가 실물 카드를 돌리는 사이 한 손으로 쓰는 화면(와이어프레임 940–1102행).
 * 좌석 화면과 같은 테이블을 180° 돌려 그린다(`orientation="dealer"`) — 딜러는
 * 자기 자리가 화면 아래에 있어야 눈앞의 배치와 곧바로 겹친다.
 *
 * 받는 이벤트는 `renderGame`뿐이다 — `REBUY_PROMPT`는 좌석 단말에만 간다.
 * 보내는 것은 `DEALER_ACTION`이고 페이로드는 `@playsync/contract`의
 * `dealer-action.ts` 스키마를 따른다. 토큰과 tableId는 싣지 않는다 —
 * 핸드셰이크에서 이미 검증돼 소켓에 박혀 있고, 인바운드 스키마(.strict())가
 * 모르는 키로 거부한다.
 *
 * 좌석을 눌러 내보내는 것(`DEALER_KICK`)이 유일한 좌석 상호작용이다 — 9행짜리
 * 좌석 표 대신 펠트의 자리를 직접 누른다.
 */
export default function DealerGameClient({
  tableId,
  initialData,
  tableOrder,
}: {
  tableId: string;
  initialData?: TableState;
  /** 눈앞의 테이블에 붙은 번호. 없으면 머리글에서 테이블을 뺀다. */
  tableOrder?: number;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [kickTarget, setKickTarget] = useState<KickTarget | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;

    // 티켓은 1회용 30초라 연결 시도마다 새로 받는다. 액세스 토큰은 이 컴포넌트에
    // 들어오지 않는다 — 쿠키를 읽는 것은 route handler(서버)뿐이다.
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
            // 새 상태가 왔다는 것은 앞의 명령이 먹었다는 뜻이다. 지난 거절
            // 사유를 남겨 두면 성공한 화면 위에 붙어 있게 된다.
            setActionError(null);
          } else if (serverEvent === 'error') {
            // 거절은 브로드캐스트가 아니라 **누른 사람에게만** 오는 ack다
            // (`ws.gateway.ts`). 상태가 그대로인 거절 — 승자 결정에서 팟
            // 하나를 안 찍은 경우 같은 것 — 은 이 문구가 없으면 화면에
            // 아무 변화도 남기지 않아 딜러가 먹은 줄 안다.
            setActionError(typeof data === 'string' && data ? data : '명령이 거절되었습니다.');
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
  }, [tableId]);

  function sendDealerAction(action: DealerAction) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ event: 'DEALER_ACTION', data: action }));
    } else {
      console.error('웹소켓 연결이 열려있지 않습니다.');
    }
  }

  // 자리를 누르면 내보내기 확인이 뜬다. 빈 자리를 누르면 확인을 접는다.
  function handleSeatClick(seatIndex: number) {
    const player = gameState?.players[seatIndex];
    if (!player) {
      setKickTarget(null);
      return;
    }
    setKickTarget({ seatIndex, id: player.id, nickname: player.nickname });
  }

  function confirmKick() {
    if (!kickTarget) return;
    sendDealerAction({ action: 'DEALER_KICK', targetUserId: kickTarget.id });
    setKickTarget(null);
  }

  function startHand() {
    sendDealerAction({ action: 'START_PRE_FLOP' });
  }

  function submitWinners(winnerGroups: string[][]) {
    sendDealerAction({ action: 'RESOLVE_WINNERS', winnerGroups });
    setShowWinnerOverlay(false);
  }

  const seatedCount = gameState?.players.filter((p) => p !== null).length ?? 0;
  const canStartHand = gameState?.phase === GamePhase.WAITING;
  const canResolveWinners = gameState?.phase === GamePhase.SHOWDOWN;

  const winnerCandidates: WinnerCandidate[] = (gameState?.players ?? []).flatMap((p, seatIndex) =>
    p ? [{ id: p.id, nickname: p.nickname, hasFolded: p.hasFolded, seatIndex }] : [],
  );

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-tb-bg text-tb-ink">
      {connectionError && (
        <div className="absolute inset-x-0 top-0 z-50 bg-err px-4 py-2 text-center text-sm font-medium text-white">
          {connectionError}
        </div>
      )}

      {/*
        **거절은 딜러가 읽고 지워야 한다.** 위쪽 띠로 걸어 두면 테이블 앞에서도
        카메라 앞에서도 지나친다 — 승자 결정 거절처럼 상태가 그대로인 실패는
        화면에 다른 변화가 없어서, 못 보면 먹은 줄 안다. 연결 끊김(위)은
        딜러가 지울 수 있는 것이 아니라 배너로 남긴다.
      */}
      {actionError && (
        <div
          data-testid="dealer-action-error"
          role="alertdialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6"
        >
          <div className="w-full max-w-[520px] border border-err bg-tb-panel p-6">
            <p className="text-xs tracking-[0.14em] text-err">명령이 거절되었습니다</p>
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

      <div className="flex shrink-0 items-center justify-between border-b border-tb-line bg-tb-panel px-4 py-2 text-xs text-tb-sub">
        {/*
          예전에는 여기에 `tableId`(uuid)가 그대로 떴다. 좌석 태블릿에서
          걷어낸 것과 같은 결함이고(B2), 딜러에게도 uuid는 아무 의미가 없다 —
          눈앞의 테이블에 붙어 있는 것은 번호다. 번호를 못 구했으면 테이블
          쪽을 통째로 뺀다.
        */}
        <span data-testid="dealer-header">{[tableOrder !== undefined ? `${tableOrder}번 테이블` : null, '딜러']
          .filter(Boolean)
          .join(' · ')}</span>
        <span>
          {gameState
            ? `${gameState.smallBlind.toLocaleString()} / ${(gameState.smallBlind * 2).toLocaleString()}`
            : '대기 중'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center p-3">
          <Felt state={gameState} orientation="dealer" mySeatIndex={null} onSeatClick={handleSeatClick} />
        </div>

        <div className="flex w-[252px] shrink-0 flex-col gap-2.5 overflow-hidden border-l border-tb-line bg-tb-panel p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="rounded border border-tb-line px-2 py-0.5 text-tb-muted">
              {PHASE_LABEL[gameState?.phase ?? 0]}
            </span>
            <span className="text-tb-sub">착석 {seatedCount}명</span>
          </div>
          <div className="text-xs text-tb-sub">
            버튼 · {gameState ? `${gameState.buttonUser + 1}번 자리` : '—'}
          </div>

          <div className="border-t border-tb-line" />

          {kickTarget ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs tracking-[0.14em] text-tb-act">자리를 비운 사람</p>
              <p className="text-sm text-tb-ink">
                {kickTarget.seatIndex + 1}번 · {kickTarget.nickname}
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setKickTarget(null)}
                  className="flex-1 rounded border border-tb-line py-2 text-xs text-tb-muted"
                >
                  취소
                </button>
                <button
                  type="button"
                  data-testid="confirm-kick"
                  onClick={confirmKick}
                  className="flex-1 rounded border border-tb-line py-2 text-xs text-tb-ink"
                >
                  내보내기
                </button>
              </div>
              <p className="text-xs text-tb-sub">
                칩은 남고, 참가 OTP로 다시 앉습니다.
              </p>
            </div>
          ) : (
            <p className="text-xs text-tb-sub">내보낼 자리를 누르세요.</p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-tb-line p-3">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!canResolveWinners}
            onClick={() => {
              // 다시 찍으러 들어가는 길이다. 지난 거절 사유를 그대로 두면
              // 새로 고른 순위 위에 앞의 실패가 걸려 있게 된다.
              setActionError(null);
              setShowWinnerOverlay(true);
            }}
            className="h-14 flex-[2] border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a] disabled:opacity-30"
          >
            승자 결정
          </button>
          <button
            type="button"
            disabled={!canStartHand}
            onClick={startHand}
            className="h-14 flex-1 border border-tb-line text-sm text-tb-ink disabled:opacity-30"
          >
            핸드 시작
          </button>
        </div>
      </div>

      {showWinnerOverlay && (
        <WinnerOverlay
          players={winnerCandidates}
          sidePots={gameState?.sidePots ?? []}
          onSubmit={submitWinners}
          onCancel={() => setShowWinnerOverlay(false)}
        />
      )}
    </div>
  );
}
