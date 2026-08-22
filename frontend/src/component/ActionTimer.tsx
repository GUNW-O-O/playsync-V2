'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 내 차례에 남은 시간.
 *
 * **서버 시각과 태블릿 시계는 다르다.** `deadline`은 서버가 만든 절대
 * 시각인데(`PlaysyncService.scheduleTurnTimeout`), 그것을 브라우저
 * `Date.now()`와 직접 비교하면 시계가 뒤처진 태블릿은 게이지가 남은 채
 * 자동 폴드되고 앞선 태블릿은 이미 지난 턴을 계속 센다. 전광판
 * (`DisplayClient`)이 같은 이유로 `serverTime`으로 오프셋을 보정한다.
 *
 * `serverNow`는 그 스냅샷이 서버를 떠난 시각이다. 여기서 오프셋을 한 번 재고
 * 그 뒤로는 브라우저 시계의 **경과**만 쓴다 — 절대 시각을 믿지 않고 흐른
 * 시간만 믿는 것이라, 태블릿 시계가 몇 분 어긋나 있어도 남은 시간은 맞는다.
 * 없으면 보정 없이 돈다(계약 이전 서버·옛 스냅샷).
 */
export default function ActionTimer({
  deadline,
  serverNow,
}: {
  deadline: number;
  /** 이 스냅샷이 서버를 떠난 시각. 없으면 브라우저 시계를 그대로 쓴다. */
  serverNow?: number;
}) {
  // 마운트 시점에 한 번만 잰다. 이후 갱신은 경과로만 하므로 이 값이 흔들리지
  // 않아야 한다.
  const offsetRef = useRef(serverNow === undefined ? 0 : serverNow - Date.now());
  const now = () => Date.now() + offsetRef.current;

  const [initialDiff] = useState(() => Math.max(0, deadline - now()));

  /**
   * **첫 값은 렌더 중에 만든다.** 예전에는 0으로 시작해 첫 인터벌(100ms)이
   * 돌아야 채워졌고, 그 사이 "0초 남음"이 뜬다 — 차례가 막 온 사람에게
   * 시간이 없다고 말하는 화면이다.
   */
  const remainingAtMount = Math.max(0, deadline - now());
  const [timeLeft, setTimeLeft] = useState(() => Math.ceil(remainingAtMount / 1000));
  const [progress, setProgress] = useState(() =>
    initialDiff > 0 ? (remainingAtMount / initialDiff) * 100 : 0,
  );

  useEffect(() => {
    // 100ms마다 실행 (초 단위 숫자와 게이지를 부드럽게 갱신)
    const timer = setInterval(() => {
      const remainingMs = deadline - now();

      if (remainingMs <= 0) {
        setTimeLeft(0);
        setProgress(0);
        clearInterval(timer);
        return;
      }

      setTimeLeft(Math.ceil(remainingMs / 1000));
      setProgress(initialDiff > 0 ? (remainingMs / initialDiff) * 100 : 0);
    }, 100);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
