'use client';

import { useState } from 'react';
import { DealerAction } from '@playsync/contract';
import Felt from '@/component/felt/Felt';
import { formatDuration } from '@/lib/format-duration';
import { useTableSocket } from '@/lib/use-table-socket';
import {
  GamePhase,
  TableState,
  TournamentClosedSchema,
  TournamentSyncingSchema,
  TOURNAMENT_SYNCING_EVENT,
  type ClosedTournamentStatus,
} from '@playsync/contract';
import WinnerOverlay, { type WinnerCandidate } from './WinnerOverlay';
import TournamentClosedOverlay from '@/component/TournamentClosedOverlay';

// 서버·소켓이 문구를 안 줄 때의 최후 안내. WS 배선(티켓 요청·정리·배너)은
// `SeatGameClient`에서 그대로 옮겨 왔다 — T24가 세운 규칙이고, 액세스 토큰이
// 이 컴포넌트에 들어오지 않는 구조를 다시 설계하지 않는다.
// **새로고침하라고 적지 않는다**(T93). 이제 화면이 스스로 다시 붙으므로,
// 사람이 할 일을 먼저 적으면 가만히 두면 낫는 상황에 손을 대게 만든다. 끝내
// 실패했을 때의 안내는 `useTableSocket`이 그 시점에 따로 내놓는다.
const DEFAULT_CONNECTION_ERROR = '연결이 끊어졌습니다.';

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
 * 좌석 상호작용은 펠트의 자리를 직접 누르는 것 하나다 — 9행짜리 좌석 표를
 * 쓰지 않는다. 누른 자리에 대해 할 수 있는 것이 둘이고, **둘은 다른 조작이다**:
 * 내보내기(`DEALER_KICK`)는 참가를 끝내고, 폴드(`DEALER_FOLD`)는 이 핸드만
 * 포기시킨다. 자리를 비운 사람이 돌아올 수 있으면 폴드다.
 */
export default function DealerGameClient({
  tableId,
  initialData,
  tableOrder,
  storeId,
}: {
  tableId: string;
  initialData?: TableState;
  /** 눈앞의 테이블에 붙은 번호. 없으면 머리글에서 테이블을 뺀다. */
  tableOrder?: number;
  /**
   * 대회가 닫힌 뒤 돌아갈 대기 화면(`/dealer?store=`). 없으면 덮개가 그
   * 안내를 빼고 머문다 — 좌석 쪽 `EliminatedOverlay`와 같은 판단이다.
   */
  storeId?: string;
}) {
  const [gameState, setGameState] = useState<TableState | null>(initialData || null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [kickTarget, setKickTarget] = useState<KickTarget | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);
  /**
   * 대회가 닫혔다는 사실. **한 번 서면 되돌리지 않는다** — 서버가 소켓을
   * 끊지 않으므로 늦게 도착한 `renderGame`이 있을 수 있고, 그것이 이 값을
   * 지우면 딜러가 끝난 대회의 펠트를 다시 만지게 된다.
   */
  const [closed, setClosed] = useState<ClosedTournamentStatus | null>(null);
  /**
   * 서버 복구 중 딜러 복귀 진행(T96). `tournamentSyncing`은 이 대회의 딜러에게만
   * 오고, 대회 단위 정렬은 서버가 보장한다(`TournamentSyncingSchema` 주석) —
   * 마지막으로 받은 값이 곧 지금 값이다.
   */
  const [sync, setSync] = useState<{ present: number; required: number } | null>(null);

  /**
   * 소켓 배선은 `useTableSocket`이 든다(T93). 좌석 화면과 두 벌로 들고 있던
   * 것을 한 벌로 모았다 — 다른 것은 받은 메시지로 무엇을 하느냐뿐이다.
   *
   * **딜러는 좌석보다 늦게 붙는다**(`reconnect-policy.ts`). 먼저 붙으면 아홉
   * 중 둘만 찬 테이블을 보게 되고, 사람이 판을 이르게 재개하는 순간이 거기다.
   */
  const { socketRef, connectionError, reconnecting } = useTableSocket({
    tableId,
    role: 'dealer',
    defaultError: DEFAULT_CONNECTION_ERROR,
    onMessage: (serverEvent, data) => {
      if (serverEvent === 'renderGame') {
        // 선을 넘어온 JSON이라 타입이 없다. **여기서 검증하지 않는 이유는
        // 서버가 이미 태우기 때문이다** — `WsGateway.toWireState`가 계약에
        // 없는 키를 지우고 위반이면 아예 안 보낸다(T71).
        setGameState(data as TableState);
        // 새 상태가 왔다는 것은 앞의 명령이 먹었다는 뜻이다. 지난 거절
        // 사유를 남겨 두면 성공한 화면 위에 붙어 있게 된다.
        setActionError(null);
      } else if (serverEvent === 'tournamentClosed') {
        // **계약을 읽는다.** 손으로 필드를 꺼내면 백엔드가 모양을 바꿔도
        // 컴파일이 통과하고 화면만 조용히 어긋난다.
        const parsed = TournamentClosedSchema.safeParse(data);
        if (parsed.success) {
          setClosed(parsed.data.status);
          // 끝난 대회의 거절 사유는 이제 읽을 값이 없다. 덮개 뒤에 남겨
          // 두면 대기 화면으로 돌아간 뒤에도 붙어 있다.
          setActionError(null);
        } else {
          console.error('tournamentClosed 계약 위반 — 무시한다.', parsed.error);
        }
      } else if (serverEvent === TOURNAMENT_SYNCING_EVENT) {
        // **계약을 읽는다.** `tournamentClosed` 분기와 같은 이유다.
        const parsed = TournamentSyncingSchema.safeParse(data);
        if (parsed.success) {
          setSync(
            parsed.data.syncing
              ? { present: parsed.data.present, required: parsed.data.required }
              : null,
          );
        } else {
          console.error('tournamentSyncing 계약 위반 — 무시한다.', parsed.error);
        }
      } else if (serverEvent === 'error') {
        // 거절은 브로드캐스트가 아니라 **누른 사람에게만** 오는 ack다
        // (`ws.gateway.ts`). 상태가 그대로인 거절 — 승자 결정에서 팟
        // 하나를 안 찍은 경우 같은 것 — 은 이 문구가 없으면 화면에
        // 아무 변화도 남기지 않아 딜러가 먹은 줄 안다.
        setActionError(typeof data === 'string' && data ? data : '명령이 거절되었습니다.');
      }
    },
  });

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

  function confirmFold() {
    if (!foldTarget) return;
    sendDealerAction({ action: 'DEALER_FOLD', targetUserId: foldTarget.id });
    setKickTarget(null);
  }

  function startHand() {
    sendDealerAction({ action: 'START_PRE_FLOP' });
  }

  function resumeTable() {
    sendDealerAction({ action: 'RESUME_TABLE' });
  }

  function retryCheckpoint() {
    sendDealerAction({ action: 'RETRY_CHECKPOINT' });
  }

  function submitWinners(winnerGroups: string[][]) {
    sendDealerAction({ action: 'RESOLVE_WINNERS', winnerGroups });
    setShowWinnerOverlay(false);
  }

  const seatedCount = gameState?.players.filter((p) => p !== null).length ?? 0;
  /*
    **닫힌 대회에서는 아무 조작도 뜻이 없다.** 같은 트랜잭션이 `Table` 행과
    Redis 스냅샷을 지웠으므로 무엇을 눌러도 돌아오는 것은 거절뿐이다.

    덮개가 화면을 가리지만 게이팅도 같이 끈다 — 덮개는 그리는 것이고 이쪽은
    누를 수 있는가라서, 하나만 두면 다른 하나를 지웠을 때 조용히 통과한다.
  */
  /*
    리바인 답을 기다리는 중. 서버가 스냅샷에 적어 보낸다
    (`PlaysyncService.markRebuyPending`).
  */
  const rebuyPending = gameState?.rebuyPending;
  const canStartHand = gameState?.phase === GamePhase.WAITING && closed === null;
  // **기다리는 동안은 승자 결정을 막는다.** 스냅샷은 이미 `HAND_END`라 이
  // 조건이 대개 거짓이지만, 늦게 도착한 쇼다운 프레임 하나면 버튼이 다시
  // 켜지고 그것을 누른 딜러는 「쇼다운 상태가 아닙니다」만 받는다.
  const canResolveWinners =
    gameState?.phase === GamePhase.SHOWDOWN && closed === null && !rebuyPending;

  // 폴드는 베팅 라운드에서만 뜻이 있다. `TableEngine.act`가 그 밖의 페이즈를
  // 통째로 던지므로, 거절을 받고 나서 알게 하지 않고 여기서 미리 끈다.
  const isBettingRound =
    gameState !== null &&
    gameState.phase >= GamePhase.PRE_FLOP &&
    gameState.phase <= GamePhase.RIVER;
  const foldTarget = kickTarget;

  /**
   * **막다른 골목의 표시다.** 핸드 종료 체크포인트가 재시도까지 실패하면
   * 백엔드는 그 자리를 안전 상태로 두고 멈춘다(`PlaysyncService`의
   * `checkpointTableToDb`). 그때 `canStartHand`는 `phase === WAITING`이라
   * 거짓이고, 승자 결정도 쇼다운이 아니라 거짓이다 — 화면의 버튼이 전부
   * 꺼진다. 왜 멈췄는지와 나올 길을 여기서 그린다.
   *
   * `RETRYING`은 백엔드가 이미 재시도를 돌리는 중이라 겹쳐 누를 이유가 없다.
   * 표시는 하고 버튼만 끈다 — 아무것도 안 그리면 딜러는 여전히 멈춘 이유를
   * 모른다.
   */
  const resumePending = gameState?.resumePending;
  const dbSyncStatus = gameState?.dbSyncStatus;
  const isCheckpointStuck = dbSyncStatus === 'RETRYING' || dbSyncStatus === 'FAILED';

  const winnerCandidates: WinnerCandidate[] = (gameState?.players ?? []).flatMap((p, seatIndex) =>
    p ? [{ id: p.id, nickname: p.nickname, hasFolded: p.hasFolded, seatIndex }] : [],
  );

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-tb-bg text-tb-ink">
      {connectionError && (
        <div className="absolute inset-x-0 top-0 z-50 bg-err px-4 py-2 text-center text-sm font-medium text-white">
          {/*
            **다시 붙는 중인지를 함께 적는다.** 문구만 있으면 읽는 사람은 자기가
            새로고침해야 하는 줄 안다 — 실제로는 기다리면 낫는다.
          */}
          {reconnecting ? `${connectionError} 다시 연결하는 중입니다…` : connectionError}
        </div>
      )}

      {/*
        **서버가 멈췄다 돌아온 테이블은 딜러가 연다**(T95).

        자동으로 풀지 않는 이유는 그 시각을 감으로 잡아야 하기 때문이다 —
        짧으면 아직 깜깜한 사람이 폴드당하고 길면 다 모인 테이블이 기다린다.
        소켓 수를 세는 방법은 게이트웨이에 하트비트가 없어(반만 닫힌 TCP는
        살아 있는 것처럼 보인다) 좀비 소켓 하나가 테이블을 영영 묶는다.

        **카드가 물리라 딜러에게는 눈이 있다.** 자리에 사람이 앉았는지는
        화면이 아니라 그 사람이 안다. 그래서 이 딜러 단말은 좌석보다 늦게
        붙는다(`reconnect-policy.ts`) — 먼저 붙으면 아홉 중 둘만 찬 테이블을
        보게 되고, 이르게 누르는 순간이 정확히 거기다.
      */}
      {resumePending && (
        <div
          data-testid="dealer-resume"
          className="absolute inset-x-0 top-0 z-50 flex items-center justify-between gap-3 bg-err px-4 py-3 text-left text-sm text-white"
        >
          <span>
            서버가 {formatDuration(resumePending.downMs)} 멈췄다 돌아왔습니다. 자리가 다 찼는지
            보고 이어서 진행하세요.
            {/*
              **서버가 아직 끝내지 못한 재개는 거절된다.** `present === required`만
              보고 버튼을 열면 그 자리 하나만 다르다 — `syncing: false`가
              올 때까지는 서버가 끝났다고 말한 것이 아니다(T96).
            */}
            {sync && ` 딜러 ${sync.present}/${sync.required} 복귀 — 전원이 돌아오면 이어서 진행할 수 있습니다.`}
          </span>
          <button
            type="button"
            disabled={sync !== null}
            onClick={resumeTable}
            className="shrink-0 border border-white px-4 py-2 text-sm font-semibold disabled:opacity-40"
          >
            이어서 진행
          </button>
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
                  data-testid="confirm-fold"
                  disabled={!isBettingRound}
                  onClick={confirmFold}
                  className="flex-1 rounded border border-tb-line py-2 text-xs text-tb-ink disabled:opacity-30"
                >
                  폴드
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
                폴드는 이 핸드만 접습니다. 내보내면 칩은 남고, 참가 OTP로 다시 앉습니다.
              </p>
            </div>
          ) : (
            <p className="text-xs text-tb-sub">내보낼 자리를 누르세요.</p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-tb-line p-3">
        {/*
          **왜 멈췄는지를 적는다.** 이 15초 동안 화면에는 아무 설명이 없었고,
          딜러가 할 수 있는 것은 거절당하는 버튼을 다시 누르는 것뿐이었다.

          자리 번호를 짚는 이유는 딜러가 보는 것이 눈앞의 테이블이라서다 —
          그 자리에 앉은 사람에게 말을 건네면 된다.
        */}
        {rebuyPending && (
          <p data-testid="rebuy-pending" className="mb-2 text-xs text-tb-act">
            {rebuyPending.seatIndexes.map((i) => i + 1).join('·')}번 자리의 리바인을
            기다립니다 — 답이 오거나 시간이 지나면 다음 핸드로 갑니다.
          </p>
        )}
        {isCheckpointStuck && (
          <p data-testid="db-sync-status" className="mb-2 text-xs text-err">
            {dbSyncStatus === 'FAILED'
              ? '저장 실패 — 저장이 끝나야 다음 핸드로 갑니다.'
              : '저장 재시도 중 — 잠시 기다려 주세요.'}
          </p>
        )}
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
          {isCheckpointStuck ? (
            <button
              type="button"
              disabled={dbSyncStatus === 'RETRYING'}
              onClick={retryCheckpoint}
              className="h-14 flex-1 border border-err text-sm text-tb-ink disabled:opacity-30"
            >
              저장 재시도
            </button>
          ) : (
            <button
              type="button"
              disabled={!canStartHand}
              onClick={startHand}
              className="h-14 flex-1 border border-tb-line text-sm text-tb-ink disabled:opacity-30"
            >
              핸드 시작
            </button>
          )}
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

      {/*
        **맨 뒤에 그린다.** 승자 결정 오버레이가 열린 채로 대회가 닫힐 수
        있고(마지막 판을 찍는 순간이 곧 정산의 시작이다), 그때 딜러가 봐야
        하는 것은 이미 뜻이 없어진 승자 목록이 아니라 끝났다는 사실이다.
      */}
      {closed !== null && (
        <TournamentClosedOverlay status={closed} storeId={storeId} terminal="dealer" />
      )}
    </div>
  );
}
