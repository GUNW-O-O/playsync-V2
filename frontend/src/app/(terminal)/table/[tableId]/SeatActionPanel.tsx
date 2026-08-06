'use client';

import { useState } from 'react';
import { PlayerAction, PlayerActionType } from '@playsync/contract';
import { TableState } from '@/app/types/game';
import ActionTimer from '@/component/ActionTimer';

/** 페이즈별 문구. `PokerTable`(구)의 배열과 같은 순서, 한글만 다르다. */
const WAITING_LABEL = '게임 시작 대기 중...';

/**
 * 좌석 화면의 액션바. 폴드·체크/콜·레이즈·올인 넷뿐이다(와이어프레임
 * 813–821행) — 딜러 분기(`isDealer`)와 리바인 UI는 여기 없다. 리바인은
 * `RebuyOverlay`가 전체 화면을 덮어 대신 그린다.
 */
export default function SeatActionPanel({
  state,
  mySeatIndex,
  onAction,
}: {
  state: TableState | null;
  mySeatIndex: number | null;
  onAction: (action: PlayerAction) => void;
}) {
  const myPlayer = state && mySeatIndex !== null ? (state.players[mySeatIndex] ?? null) : null;
  const bigBlind = (state?.smallBlind ?? 0) * 2;
  const [raiseVal, setRaiseVal] = useState(Math.min(bigBlind, myPlayer?.stack ?? 0));

  // 내 차례가 되면 레이즈 슬라이더를 최소 레이즈로 되돌린다. 이전 핸드에서
  // 남은 값을 그대로 보여주면 실수로 그 금액을 그대로 쏠 수 있다. 이펙트
  // 대신 렌더 중 조정한다(React 문서가 권하는 "prop이 바뀌면 state를
  // 조정하는" 패턴) — 이펙트로 하면 커밋이 한 번 더 생기고, 그 사이
  // 프레임에 되돌리기 전 값이 잠깐 보인다.
  const turnKey = `${state?.currentTurnSeatIndex ?? -1}:${state?.phase ?? -1}`;
  const [lastTurnKey, setLastTurnKey] = useState(turnKey);
  if (turnKey !== lastTurnKey) {
    setLastTurnKey(turnKey);
    if (state && mySeatIndex !== null && state.currentTurnSeatIndex === mySeatIndex) {
      setRaiseVal(Math.min(state.currentBet + bigBlind, myPlayer?.stack ?? 0));
    }
  }

  if (!state) {
    return <Placeholder>{WAITING_LABEL}</Placeholder>;
  }
  if (state.phase === 5 || state.phase === 6) {
    return <Placeholder>핸드 결과 대기 중...</Placeholder>;
  }
  if (state.currentTurnSeatIndex === -1 || state.phase === 0 || !myPlayer) {
    return <Placeholder>{WAITING_LABEL}</Placeholder>;
  }
  if (state.currentTurnSeatIndex !== mySeatIndex) {
    return <Placeholder>상대방 턴 대기 중...</Placeholder>;
  }

  const needsToCall = state.currentBet - myPlayer.bet;
  const canCheck = needsToCall <= 0;
  const goingToAllIn = needsToCall >= myPlayer.stack;
  const canRaise = raiseVal >= state.currentBet + bigBlind;

  return (
    <div className="flex flex-col gap-2.5">
      {!goingToAllIn && (
        <div className="flex h-7 items-center gap-3 border border-tb-line bg-tb-panel px-3 font-mono text-[11px] text-tb-muted">
          <input
            type="range"
            min={state.currentBet + bigBlind}
            // `amount`는 총 베팅액이다(`table-engine.ts`의 `handleRaise`가
            // `betAmount - player.bet`을 뺀다) — 낼 수 있는 최대 총액은
            // `stack`이 아니라 `stack + bet`이다(올인 버튼과 같은 값).
            max={Math.max(myPlayer.stack + myPlayer.bet, state.currentBet + bigBlind)}
            step={bigBlind || 1}
            value={raiseVal}
            onChange={(e) => setRaiseVal(Number(e.target.value))}
            className="h-1 flex-1 accent-[color:var(--tb-act)]"
          />
          <span className="text-tb-ink">{raiseVal.toLocaleString()}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onAction({ action: PlayerActionType.FOLD })}
          className="h-14 flex-1 border border-tb-line text-sm text-tb-muted"
        >
          폴드
        </button>

        {goingToAllIn ? (
          <button
            type="button"
            onClick={() => onAction({ action: PlayerActionType.CALL })}
            className="h-14 flex-[2] border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a]"
          >
            올인 콜
          </button>
        ) : (
          <>
            {canCheck ? (
              <button
                type="button"
                onClick={() => onAction({ action: PlayerActionType.CHECK })}
                className="h-14 flex-1 border border-tb-line text-sm text-tb-ink"
              >
                체크
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onAction({ action: PlayerActionType.CALL })}
                className="h-14 flex-1 border border-tb-line text-sm text-tb-ink"
              >
                콜 {Math.min(needsToCall, myPlayer.stack).toLocaleString()}
              </button>
            )}
            <button
              type="button"
              disabled={!canRaise}
              onClick={() => onAction({ action: PlayerActionType.RAISE, amount: raiseVal })}
              className="h-14 flex-1 border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a] disabled:opacity-30"
            >
              레이즈 {raiseVal.toLocaleString()}
            </button>
            <button
              type="button"
              onClick={() =>
                onAction({ action: PlayerActionType.RAISE, amount: myPlayer.stack + myPlayer.bet })
              }
              className="h-14 flex-1 border border-tb-line text-sm text-tb-ink"
            >
              올인
            </button>
          </>
        )}
      </div>

      {state.actionDeadline && <ActionTimer key={state.actionDeadline} deadline={state.actionDeadline} />}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-14 items-center justify-center text-sm italic text-tb-sub">{children}</div>
  );
}
