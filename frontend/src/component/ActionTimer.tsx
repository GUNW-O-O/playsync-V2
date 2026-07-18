'use client';

import { useEffect, useState } from 'react';

export default function ActionTimer({ deadline }: { deadline: number }) {
  // 처음 렌더링될 때의 남은 전체 시간 (게이지 비율 계산용)
  const [initialDiff] = useState(() => Math.max(0, deadline - Date.now()));
  const [timeLeft, setTimeLeft] = useState(0);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    // 100ms마다 실행 (초 단위 숫자와 게이지를 부드럽게 갱신)
    const timer = setInterval(() => {
      const now = Date.now();
      const remainingMs = deadline - now;

      if (remainingMs <= 0) {
        setTimeLeft(0);
        setProgress(0);
        clearInterval(timer);
        return;
      }

      setTimeLeft(Math.ceil(remainingMs / 1000));
      setProgress((remainingMs / initialDiff) * 100);
    }, 100);

    return () => clearInterval(timer);
  }, [deadline, initialDiff]);

  // 시간에 따른 시각적 상태 (위험도 표시)
  const isUrgent = timeLeft <= 5;

  return (
    <div className="w-full flex flex-col items-center gap-1">
      {/* 게이지 바 */}
      <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden border border-white/5">
        <div
          className={`h-full transition-all duration-150 ease-linear ${isUrgent ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-indigo-500'
            }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* 숫자 표시 */}
      <div className="flex items-center gap-1.5">
        <span className={`text-xl font-black tabular-nums ${isUrgent ? 'text-red-500 animate-pulse' : 'text-slate-200'}`}>
          {timeLeft}
        </span>
        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-tighter">seconds left</span>
      </div>
    </div>
  );
}