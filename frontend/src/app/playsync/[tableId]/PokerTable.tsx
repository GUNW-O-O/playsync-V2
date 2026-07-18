import { TableState } from "@/app/types/game";

export default function PokerTable({ state, mySeatIndex }: { state: TableState | null, mySeatIndex: number | null }) {
  const seatStyles = [
    { top: '10%', left: '67%', transform: 'translateX(-50%)' },
    { top: '23%', right: '5%' },
    { top: '55%', right: '5%' },
    { bottom: '8%', right: '20%' },
    { bottom: '4%', left: '50%', transform: 'translateX(-50%)' },
    { bottom: '8%', left: '20%' },
    { top: '55%', left: '5%' },
    { top: '23%', left: '5%' },
    { top: '10%', left: '33%', transform: 'translateX(-50%)' },
  ];

  const mySeat = mySeatIndex ?? null;
  const phases = ['WAITING', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'HAND_END'];

  // 페이즈별 활성화될 카드 개수 계산 (0: 프리플랍, 3: 플랍, 4: 턴, 5: 리버)
  const getActiveCardCount = (p: number) => {
    if (p <= 1) return 0;
    if (p === 2) return 3;
    if (p === 3) return 4;
    if (p >= 4) return 5;
    return 0;
  };

  return (
    <div className="w-full h-full relative flex items-center justify-center p-6 bg-slate-950 font-sans">
      {/* 물리적 테이블 */}
      <div className="w-[92%] h-[70%] bg-emerald-900 rounded-[200px] border-[10px] border-amber-950 flex flex-col items-center justify-center shadow-2xl relative">
        
        {state && (
          <div className="w-full flex flex-col items-center gap-6">
            {/* 상단 정보바: 로고 | 팟 | 페이즈 평행 배치 */}
            <div className="flex items-center gap-8 z-10">
              <div className="text-white/80 text-xl font-black italic select-none tracking-tighter">{(state.smallBlind ? `${state.smallBlind.toLocaleString()}/${(state.smallBlind * 2).toLocaleString()}` : 'PLAY SYNC')}</div>
              
              <div className="flex items-center gap-4 bg-black/40 px-6 py-2 rounded-full border border-white/10 shadow-inner">
                <div className="flex flex-col items-center border-r border-white/10 pr-4">
                  <span className="text-[10px] text-yellow-600 font-bold uppercase">Total Pot</span>
                  <span className="text-xl font-black text-yellow-400">{state.pot.toLocaleString()}</span>
                </div>
                <div className="flex flex-col items-center pl-1">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Phase</span>
                  <span className="text-sm font-bold text-white/80">{phases[state.phase]}</span>
                </div>
              </div>
            </div>

            {/* 중앙 커뮤니티 카드 슬롯 */}
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, idx) => {
                const isActive = idx < getActiveCardCount(state.phase);
                return (
                  <div 
                    key={idx}
                    className={`w-10 h-13 rounded-md border-2 flex items-center justify-center transition-all duration-500
                      ${isActive 
                        ? 'bg-white border-white shadow-[0_0_10px_rgba(255,255,255,0.3)]' 
                        : 'bg-black/20 border-white/5 border-dashed'
                      }`}
                  >
                    {!isActive && <div className="w-1 h-1 bg-white/5 rounded-full" />}
                    {isActive && <span className="text-emerald-900 font-bold">🂠</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 좌석 렌더링 */}
      {Array.from({ length: 9 }).map((_, i) => {
        const player = state?.players[i] || null;
        const isCurrentTurn = state?.currentTurnSeatIndex === i;
        const isButton = state?.buttonUser === i;

        return (
          <div key={i} className="absolute transition-all duration-300 z-20" style={seatStyles[i]}>
            {isButton && (
              <div className="absolute -top-2 -right-2 w-7 h-7 bg-white border-2 border-slate-400 rounded-full flex items-center justify-center text-black font-black text-xs shadow-xl z-30">D</div>
            )}

            {/* 유저 박스 높이 축소: h-22 -> h-18 */}
            <div className={`w-20 h-18 rounded-xl flex flex-col items-center justify-between py-1.5 border-2 transition-all shadow-xl
              ${player ? 'bg-slate-900 border-slate-700' : 'bg-black/30 border-white/5 border-dashed'}
              ${isCurrentTurn ? 'border-yellow-400 ring-4 ring-yellow-400/20 scale-105 bg-slate-800' : ''}`}>

              {player ? (
                <>
                  <span className={`text-[11px] font-black truncate w-full text-center px-1 ${i === mySeat ? 'text-rose-500' : 'text-slate-100'}`}>
                    {player.nickname}
                  </span>
                  {/* <span className="text-[9px] text-blue-400 font-bold">{i === mySeat ? `★ ME ${i + 1}번` : `${i + 1}번`}</span> */}
                  <span className="text-yellow-300 text-[12px] font-black">{player.stack.toLocaleString()}</span>

                  {/* 베팅 금액 간격 조정 */}
                  {player.bet > 0 && (
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[9px] px-2 py-0.5 rounded-full font-black border border-blue-400 shadow-md">
                      {player.bet.toLocaleString()}
                    </div>
                  )}

                  {/* 올인 효과 */}
                  {player.isAllIn && (
                    <div className="absolute inset-0 bg-rose-600/20 border-2 border-rose-500 rounded-xl flex items-center justify-center z-10 animate-pulse">
                      <span className="text-[9px] font-black text-white bg-rose-600 px-1.5 py-0.5 rounded shadow-sm">ALL-IN</span>
                    </div>
                  )}

                  {player.hasFolded && (
                    <div className="absolute inset-0 bg-black/60 rounded-xl flex items-center justify-center z-10 backdrop-blur-[1px]">
                      <span className="text-[10px] font-black text-slate-500 italic">FOLD</span>
                    </div>
                  )}
                </>
              ) : (
                <span className="text-white/5 font-bold text-[9px] uppercase">Empty</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}