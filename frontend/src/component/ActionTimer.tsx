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

  /*
    높이를 고정한다(`h-9`). 이 컴포넌트가 붙었다 떨어지는 자리가 액션바
    바로 아래라, 크기가 변하면 버튼 줄이 위아래로 움직인다.

    색은 단말 팔레트(`--tb-*`)를 쓴다. 예전에는 slate/indigo였는데, 그건
    이 화면 어디에도 없는 색이라 타이머만 다른 앱에서 떼어 온 것처럼 보였다.
    문구도 `seconds left`가 아니라 한국어다 — 나머지 화면이 전부 한국어다.
  */
  return (
    <div className="flex h-9 w-full flex-col items-center justify-center gap-1">
      <div className="h-1.5 w-full overflow-hidden border border-tb-line bg-tb-bg">
        <div
          className={`h-full transition-[width] duration-150 ease-linear ${
            isUrgent ? 'bg-err' : 'bg-tb-act'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div
        className={`font-mono text-sm tabular-nums ${isUrgent ? 'text-err' : 'text-tb-muted'}`}
      >
        {timeLeft}초 남음
      </div>
    </div>
  );
}