'use client'
import { ActionType } from "@/app/types/game";
import ActionTimer from "@/component/ActionTimer";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function ActionPanel({ state, mySeatIndex, isDealer, onAction, onRebuyResponse, rebuyData }: any) {
  const router = useRouter();
  if (!state) return <div className="text-slate-600 text-center mt-10 italic">게임 시작 대기 중...</div>;

  return (
    <div className="h-full flex flex-col gap-4">
      {isDealer ? (
        <DealerSection state={state} onAction={onAction} />
      ) : (
        <PlayerSection
          state={state}
          mySeatIndex={mySeatIndex}
          onAction={onAction}
          rebuyData={rebuyData}
          onRebuyResponse={onRebuyResponse}
          router={router}
        />
      )}
    </div>
  );
}

// 플레이어 섹션 (BB 기준 슬라이더 포함)
function PlayerSection({ state, mySeatIndex, onAction, rebuyData, onRebuyResponse, router}: any) {
  const bigBlind = state.smallBlind * 2;
  const myPlayer = state.players[mySeatIndex];
  const [raiseVal, setRaiseVal] = useState(Math.min(bigBlind, myPlayer?.stack || 0));
  const needsToCall = state.currentBet - myPlayer?.bet || 0;
  const canCheck = needsToCall === 0;
  const goingToAllIn = needsToCall >= myPlayer?.stack;
  const canRaise = raiseVal >= state.currentBet + bigBlind;

  useEffect(() => {
    if (state.currentTurnSeatIndex === mySeatIndex) {
      setRaiseVal(state.currentBet + bigBlind);
    }
  }, [state.currentTurnSeatIndex, state.phase]);

  const handleExit = () => {
    onRebuyResponse(false);
    router.push('/playsync');
  };

  if (rebuyData) {
    return (
      <div className="flex flex-col gap-4 animate-in fade-in zoom-in duration-300">
        <h2 className="text-rose-400 font-black text-sm uppercase flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
          </span>
          Rebuy Opportunity
        </h2>

        <div className="bg-rose-950/30 p-4 rounded-xl border border-rose-500/20 space-y-4">
          <div className="flex flex-col items-center gap-1">
            <p className="text-[10px] text-rose-300/60 font-bold uppercase">Tournament</p>
            <p className="text-white font-black text-lg">{rebuyData.tournamentName}</p>
          </div>

          <div className="grid grid-cols-2 gap-4 py-2 border-y border-white/5">
            <div className="text-center">
              <p className="text-[9px] text-slate-500 font-bold uppercase">My Points</p>
              <p className="text-sm font-black text-slate-200">{rebuyData.userPoints.points.toLocaleString()}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-slate-500 font-bold uppercase">Rebuy Fee</p>
              <p className="text-sm font-black text-yellow-400">-{rebuyData.entryFee.toLocaleString()}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onRebuyResponse(true)}
              className="h-14 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-black text-sm transition-colors shadow-lg shadow-indigo-900/20"
            >
              REBUY & CONTINUE
            </button>
            <button
              onClick={handleExit}
              className="h-14 bg-slate-800 hover:bg-slate-700 rounded-xl font-black text-sm text-slate-400 transition-colors"
            >
              EXIT
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          <ActionTimer key={rebuyData.deadline} deadline={rebuyData.deadline} />
          <p className="text-[9px] text-center text-rose-400 font-bold tracking-tighter uppercase animate-pulse">
            Decision Required Before Timeout
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === 5 || state.phase === 6) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 font-bold italic animate-pulse">핸드결과 / 리바인 대기 중...</div>;
  }
  if (state.currentTurnSeatIndex === -1 || state.phase === 0) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 font-bold italic animate-pulse">게임시작 대기 중...</div>;
  }
  if (state.currentTurnSeatIndex !== mySeatIndex) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 font-bold italic animate-pulse">상대방 턴 대기 중...</div>;
  }


  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-indigo-400 font-black text-sm uppercase">Player Actions</h2>

      {/* BB 슬라이더 */}
      <div className="bg-black/40 p-3 rounded-xl space-y-3 border border-white/5">
        <div className="flex justify-between text-xs font-bold">
          <span className="text-slate-400">RAISE AMOUNT</span>
          <span className="text-yellow-400">{raiseVal.toLocaleString()}</span>
        </div>
        <input
          type="range" min={state.currentBet + bigBlind} max={myPlayer?.stack} step={bigBlind}
          value={raiseVal} onChange={(e) => setRaiseVal(Number(e.target.value))}
          className="w-full h-2 bg-slate-700 rounded-lg appearance-none accent-indigo-500"
        />
        <div className="grid grid-cols-4 gap-1">
          <button onClick={() => setRaiseVal(Math.min(state.smallBlind * 4, myPlayer?.stack))} className="bg-slate-800 py-1 rounded text-[10px] font-bold hover:bg-indigo-600">
            2BB
          </button>
          {[0.3, 0.5, 1].map(p => (
            <button key={p} onClick={() => setRaiseVal(Math.min(Math.round(state.pot * p), myPlayer?.stack))} className="bg-slate-800 py-1 rounded text-[10px] font-bold hover:bg-indigo-600">
              {p * 100}%
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {goingToAllIn ? (
          <>
            <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.CALL, amount: myPlayer?.stack })} className="h-14 bg-rose-900 rounded-xl font-black">ALL-IN TO CALL</button>
            <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.FOLD })} className="h-14 bg-red-700 rounded-xl font-black">FOLD</button>
          </>
        ) : (
          <>
            <button disabled={!canRaise} onClick={() => onAction('PLAYER_ACTION', { action: ActionType.RAISE, amount: raiseVal })} className="h-14 bg-indigo-700 rounded-xl font-black text-sm disabled:opacity-30">RAISE TO {raiseVal.toLocaleString()}</button>
            <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.RAISE, amount: myPlayer?.stack + myPlayer?.bet })} className="h-14 bg-rose-900 rounded-xl font-black">ALL-IN</button>
            {canCheck ? (
              <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.CHECK })} className="h-14 bg-slate-700 rounded-xl font-black border-2 border-emerald-500">CHECK</button>
            ) : (
              <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.CALL })} className="h-14 bg-blue-700 rounded-xl font-black">CALL ({Math.min(needsToCall, myPlayer?.stack).toLocaleString()})</button>
            )}
            <button onClick={() => onAction('PLAYER_ACTION', { action: ActionType.FOLD })} className="h-14 bg-red-700 rounded-xl font-black">FOLD</button>
          </>
        )}
      </div>
      {state.actionDeadline && (
        <div className="mt-2 space-y-1">
          <ActionTimer key={state.actionDeadline} deadline={state.actionDeadline} />
          <p className="text-[9px] text-center text-slate-600 font-bold tracking-tighter uppercase">Remaining Decision Time</p>
        </div>
      )}
    </div>
  );
}

// 딜러 섹션 (승자 선택 포함)
function DealerSection({ state, onAction }: any) {
  const [winners, setWinners] = useState<string[]>([]);
  const phase = ['WAITING', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'HAND_END']

  // 승자 결정 단계인지 확인 (SHOWDOWN = 5, HAND_END = 6 등으로 가정)
  const isResolvePhase = state.phase === 5 || state.phase === 6;

  return (
    <div className="flex flex-col gap-4 p-4 bg-slate-900 rounded-2xl border border-slate-800">
      <div className="flex justify-between items-center">
        <h2 className="text-amber-500 font-black text-xs uppercase tracking-widest">Dealer Console</h2>
        <span className="text-[10px] text-slate-500">PHASE: {phase[state.phase]}</span>
      </div>

      {/* 플레이어 선택 그리드 */}
      <div className="grid grid-cols-3 gap-2">
        {state.players.map((p: any, i: number) => {
          if (!p) return null;
          const isSelected = winners.includes(p.id);
          const selectOrder = winners.indexOf(p.id) + 1;

          return (
            <button
              key={p.id}
              onClick={() => setWinners(prev =>
                prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id]
              )}
              className={`relative p-2 rounded-lg border-2 font-bold transition-all ${isSelected
                ? 'bg-amber-500 border-white text-black'
                : 'bg-slate-800 border-slate-700 text-slate-400'
                } ${p.hasFolded ? 'opacity-40' : ''}`}
            >
              {isSelected && (
                <div className="absolute -top-2 -right-2 bg-blue-600 text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center border-2 border-slate-900">
                  {selectOrder}
                </div>
              )}
              <div className="text-[10px] truncate">{p.nickname}</div>
              <div className="text-[8px] opacity-60">{p.hasFolded ? 'FOLD' : 'ACTIVE'}</div>
            </button>
          );
        })}
      </div>

      {/* 상황별 액션 버튼 */}
      <div className="flex flex-col gap-2">
        {isResolvePhase ? (
          <button
            disabled={winners.length === 0}
            onClick={() => {
              onAction('DEALER_ACTION', { action: 'RESOLVE_WINNERS', winnerUserIds: winners });
              setWinners([]);
            }}
            className="bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 h-12 rounded-xl font-black text-white shadow-lg transition-colors"
          >
            CONFIRM WINNERS ({winners.length})
          </button>
        ) : state.phase === 0 ? (
          <button
            onClick={() => onAction('DEALER_ACTION', { action: 'START_PRE_FLOP' })}
            className="bg-emerald-600 hover:bg-emerald-500 h-12 rounded-xl font-black text-white"
          >
            START NEW HAND
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              disabled={winners.length !== 1}
              onClick={() => {
                onAction('DEALER_ACTION', { action: 'DEALER_FOLD', targetUserId: winners[0] });
                setWinners([]);
              }}
              className="bg-red-900/50 hover:bg-red-800 border border-red-700 disabled:opacity-30 py-3 rounded-lg text-[10px] font-bold text-red-200"
            >
              FORCE FOLD
            </button>
            <button
              disabled={winners.length !== 1}
              onClick={() => {
                onAction('DEALER_ACTION', { action: 'DEALER_KICK', targetUserId: winners[0] });
                setWinners([]);
              }}
              className="bg-slate-800 hover:bg-black border border-slate-700 disabled:opacity-30 py-3 rounded-lg text-[10px] font-bold text-white"
            >
              KICK PLAYER
            </button>
          </div>
        )}
      </div>
    </div>
  );
}