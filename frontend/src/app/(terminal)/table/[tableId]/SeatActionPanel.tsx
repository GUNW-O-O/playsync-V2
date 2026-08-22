'use client';

import { useState } from 'react';
import { PlayerAction, PlayerActionType } from '@playsync/contract';
import { TableState } from '@playsync/contract';
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

  // `amount`는 총 베팅액이다 — `table-engine.ts`의 `handleRaise`가
  // `betAmount - player.bet`을 빼서 실제로 낼 칩을 구한다. 그래서 낼 수 있는
  // 최대 총액은 `stack`이 아니라 **`stack + bet`**이다.
  //
  // 이 값을 한 곳에서만 계산하는 것이 요점이다. 예전에는 슬라이더 `max`와
  // 올인 버튼은 `stack + bet`을, 차례 초기화는 `stack`을 썼고, 그래서
  // 블라인드를 이미 깐 사람이 낼 수 있는 최소 레이즈를 못 냈다(T68).
  const maxTotal = myPlayer ? myPlayer.stack + myPlayer.bet : 0;
  // **최소 레이즈 폭은 BB가 아니라 직전 레이즈 폭이다**(노리밋 홀덤). 엔진이
  // 그 규칙을 지키므로(`table-engine.ts`의 `handleRaise`), 여기서 BB로 잡으면
  // 큰 레이즈 뒤에 불법 금액을 슬라이더에 그리고 사용자는 누른 뒤에야 거절을
  // 본다. 값이 없으면 BB다 — 스트리트의 첫 베팅이거나 옛 스냅샷이다.
  const minRaiseSize = state?.lastRaiseSize ?? bigBlind;
  const minRaiseTotal = (state?.currentBet ?? 0) + minRaiseSize;
  /**
   * 레이즈할 여력이 되는가. `goingToAllIn`("콜하면 다 들어가나")과 다른
   * 질문이다 — 콜이 다 들어가지 않아도 최소 레이즈에 못 미칠 수 있다.
   * 거짓이면 슬라이더와 레이즈 버튼을 감춘다(콜과 올인은 남는다). 그래야
   * 낼 수 없는 금액이 화면에서 사라지고, 슬라이더의 `min > max`도 생기지
   * 않는다 — `min > max`인 상황이 바로 "레이즈 못 하는 상황"이다.
   */
  const canRaiseAtAll = state !== null && myPlayer !== null && maxTotal >= minRaiseTotal;

  // 초기값은 자리만 잡는다. 이 값의 주인은 아래의 "지금 내 차례인가" 판정
  // 하나뿐이고, 슬라이더와 레이즈 버튼은 내 차례에만 그려지므로 여기 0이
  // 화면에 닿는 경우가 없다 — 내 차례면 렌더 중에 이미 세워진 뒤다.
  const [raiseVal, setRaiseVal] = useState(0);

  // 내 차례면 레이즈 슬라이더를 최소 레이즈로 세운다. 이전 핸드에서 남은
  // 값을 그대로 보여주면 실수로 그 금액을 그대로 쏠 수 있다. 이펙트 대신
  // 렌더 중 조정한다(React 문서가 권하는 "prop이 바뀌면 state를 조정하는"
  // 패턴) — 이펙트로 하면 커밋이 한 번 더 생기고, 그 사이 프레임에 세우기
  // 전 값이 잠깐 보인다.
  //
  // 판정은 "차례가 바뀌었나"가 아니라 **"지금 내 차례인가"**다. 차례 변화만
  // 보면 시드값이 곧 현재 차례라, 내 차례 도중에 새로고침·재접속으로
  // 마운트된 경우 한 번도 돌지 않는다 — `raiseVal`이 슬라이더 `min`보다
  // 작은 채 남아 슬라이더를 건드리기 전까지 레이즈가 불가능했다(T68).
  const myTurnKey =
    state && mySeatIndex !== null && state.currentTurnSeatIndex === mySeatIndex
      ? `${state.currentTurnSeatIndex}:${state.phase}`
      : null;

  // 차례가 나를 떠나면 키를 `null`로 되돌린다. 한 페이즈 안에서도 상대의
  // 레이즈를 거쳐 차례가 다시 오는데, 키가 `${좌석}:${페이즈}`라 그냥 두면
  // 같은 값이어서 다시 서지 않는다 — 올라간 `currentBet` 아래에 옛 값이
  // 남아 둘째와 같은 증상이 된다.
  const [seededTurnKey, setSeededTurnKey] = useState<string | null>(null);
  if (myTurnKey !== seededTurnKey) {
    setSeededTurnKey(myTurnKey);
    if (myTurnKey !== null) setRaiseVal(Math.min(minRaiseTotal, maxTotal));
  }

  /**
   * 차례가 아닐 때 무엇을 적을지. 예전에는 여기서 컴포넌트를 통째로 일찍
   * 반환했는데, 그러면 슬라이더와 타이머가 사라지면서 **버튼 줄이 위아래로
   * 움직였다.** 좌석 태블릿은 팔 길이에서 보는 고정 기기라, 방금까지
   * `폴드`가 있던 자리를 눌러 `올인`이 나가는 것이 실제 위험이다.
   *
   * 그래서 자리는 늘 잡아 두고 **내용만 바뀐다.**
   */
  const waitingLabel = !state
    ? WAITING_LABEL
    : state.phase === 5 || state.phase === 6
      ? '핸드 결과 대기 중...'
      : state.currentTurnSeatIndex === -1 || state.phase === 0 || !myPlayer
        ? WAITING_LABEL
        : state.currentTurnSeatIndex !== mySeatIndex
          ? '상대방 턴 대기 중...'
          : null;
  const myTurn = waitingLabel === null && state !== null && myPlayer !== null;

  const needsToCall = state && myPlayer ? state.currentBet - myPlayer.bet : 0;
  const canCheck = needsToCall <= 0;
  const goingToAllIn = myPlayer ? needsToCall >= myPlayer.stack : false;
  const canRaise = canRaiseAtAll && raiseVal >= minRaiseTotal && raiseVal <= maxTotal;

  return (
    <div className="flex flex-col gap-2.5">
      {/* 슬라이더 자리. 콜만 해도 다 들어가거나 레이즈할 여력이 없으면
          조절할 것이 없다. 자리는 그대로 두고 내용만 비운다. */}
      <div data-testid="action-slider-slot" className="h-7">
        {myTurn && !goingToAllIn && canRaiseAtAll && state && myPlayer && (
          <div className="flex h-7 items-center gap-3 border border-tb-line bg-tb-panel px-3 font-mono text-[11px] text-tb-muted">
            <input
              type="range"
              min={minRaiseTotal}
              // `canRaiseAtAll`이 참일 때만 그리므로 `min <= max`가 보장된다.
              max={maxTotal}
              step={bigBlind || 1}
              value={raiseVal}
              onChange={(e) => setRaiseVal(Number(e.target.value))}
              className="h-1 flex-1 accent-[color:var(--tb-act)]"
            />
            <span className="text-tb-ink">{raiseVal.toLocaleString()}</span>
          </div>
        )}
      </div>

      <div data-testid="action-buttons-slot" className="flex h-14 gap-2">
        {!myTurn || !state || !myPlayer ? (
          <div className="flex h-14 flex-1 items-center justify-center text-sm italic text-tb-sub">
            {waitingLabel}
          </div>
        ) : (
          <>
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
                className="h-14 flex-[3] border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a]"
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
                {/* 레이즈할 여력이 없으면 아예 두지 않는다. 비활성 버튼으로
                    남기면 낼 수 없는 금액이 계속 적혀 있다. */}
                {canRaiseAtAll && (
                  <button
                    type="button"
                    disabled={!canRaise}
                    onClick={() => onAction({ action: PlayerActionType.RAISE, amount: raiseVal })}
                    className="h-14 flex-1 border border-tb-act bg-tb-act text-sm font-semibold text-[#06201a] disabled:opacity-30"
                  >
                    레이즈 {raiseVal.toLocaleString()}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onAction({
                      action: PlayerActionType.RAISE,
                      amount: maxTotal,
                    })
                  }
                  className="h-14 flex-1 border border-tb-line text-sm text-tb-ink"
                >
                  올인
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* 타이머 자리. 차례가 아니면 비어 있지만 높이는 그대로다. */}
      <div data-testid="action-timer-slot" className="h-9">
        {myTurn && state?.actionDeadline && (
          <ActionTimer
            key={state.actionDeadline}
            deadline={state.actionDeadline}
            // 서버가 봉투에 찍은 시각. 태블릿 시계가 어긋나 있어도 남은 시간이
            // 맞으려면 이 값이 있어야 한다(`ws.gateway.ts`의 `toWireState`).
            serverNow={state.serverTime}
          />
        )}
      </div>
    </div>
  );
}
