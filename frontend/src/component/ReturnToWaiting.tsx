'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 대기 화면으로 돌아가기까지 세는 초. 덮개들이 같은 값을 쓴다 — 상수가 여기 하나다. */
const COUNTDOWN_SECONDS = 7;

/**
 * 「N초 뒤 대기 화면으로」 — 막대, 남은 초, 「지금 돌아가기」.
 *
 * 탈락 · 좌석 해제 덮개(`EliminatedOverlay`)와 대회 종료 덮개
 * (`TournamentClosedOverlay`)가 같은 것을 각자 들고 있었다. 문구와 배지는 각자의
 * 것이지만 세는 방식과 돌아가는 동작은 하나여야 한다 — 한쪽만 고쳐지면 같은
 * 태블릿이 덮개에 따라 다른 속도로 돌아간다.
 *
 * **갈 곳을 아는 쪽만 그린다.** 주소를 못 구했을 때 무엇을 적을지는 덮개마다
 * 다르므로 부르는 쪽이 정한다.
 */
export default function ReturnToWaiting({ waitingUrl }: { waitingUrl: string }) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (secondsLeft <= 0) {
      router.push(waitingUrl);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, waitingUrl]);

  return (
    <>
      <div className="mt-4 h-1 bg-tb-line">
        <div
          className="h-full bg-tb-act transition-[width] duration-1000 ease-linear"
          style={{ width: `${(secondsLeft / COUNTDOWN_SECONDS) * 100}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-tb-sub">
        {secondsLeft}초 뒤 대기 화면으로 돌아갑니다
      </div>

      <button
        type="button"
        onClick={() => router.push(waitingUrl)}
        className="mt-5 w-full border border-tb-line py-2.5 text-sm text-tb-muted"
      >
        지금 돌아가기
      </button>
    </>
  );
}
