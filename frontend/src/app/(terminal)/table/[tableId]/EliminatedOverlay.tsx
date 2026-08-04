'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 와이어프레임 904–905행 "7초 뒤 대기 화면으로 돌아갑니다". */
const COUNTDOWN_SECONDS = 7;

/**
 * 이 사람의 대회가 이 좌석에서 끝났을 때 화면을 덮는다(와이어프레임
 * 885–922행). 순위·상금은 그리지 않는다 — 이 기기는 다음 사람이 앉을
 * 자리라, 사람에게 붙는 정보(폰의 `GET /user/me/participations`)를 여기
 * 남겨 둘 이유가 없다.
 *
 * 카운트다운이 끝나면 대기 화면(`/table?store=`)으로 돌아간다. 좌석
 * 토큰은 여기서 버려지는 게 아니라 — 다음 사람이 새 OTP로 다시 발급받을
 * 좌석 토큰이 이 자리를 덮어쓴다.
 */
export default function EliminatedOverlay({ storeId }: { storeId?: string }) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const waitingUrl = `/table?store=${storeId ?? ''}`;

  useEffect(() => {
    if (secondsLeft <= 0) {
      router.push(waitingUrl);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6">
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6 text-center">
        <p className="text-xs tracking-[0.14em] text-tb-act">수고하셨습니다</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">
          이 테이블에서의 대회가 끝났습니다
        </div>
        <p className="text-sm leading-relaxed text-tb-muted">
          순위와 상금은 <strong className="text-tb-ink">폰에서 확인</strong>하세요.
        </p>

        <div className="mt-4 h-1 bg-tb-line">
          <div
            className="h-full bg-tb-act transition-[width] duration-1000 ease-linear"
            style={{ width: `${(secondsLeft / COUNTDOWN_SECONDS) * 100}%` }}
          />
        </div>
        <div className="mt-2 text-xs text-tb-sub">{secondsLeft}초 뒤 대기 화면으로 돌아갑니다</div>

        <button
          type="button"
          onClick={() => router.push(waitingUrl)}
          className="mt-5 w-full border border-tb-line py-2.5 text-sm text-tb-muted"
        >
          지금 돌아가기
        </button>
      </div>
    </div>
  );
}
