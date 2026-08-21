'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 와이어프레임 904–905행 "7초 뒤 대기 화면으로 돌아갑니다". */
const COUNTDOWN_SECONDS = 7;

/**
 * 이 좌석에서 이 사람이 빠졌을 때 화면을 덮는다(와이어프레임 885–922행).
 * 순위·상금은 그리지 않는다 — 이 기기는 다음 사람이 앉을 자리라, 사람에게
 * 붙는 정보(폰의 `GET /user/me/participations`)를 여기 남겨 둘 이유가 없다.
 *
 * 뜨는 계기가 둘이다 — 실제 탈락과, 상점이 좌석만 해제한 경우(T29, 칩은
 * 남고 자리만 잃는다)다. 둘을 구분해서 그리지 않는다. 문구가 탈락 전용이면
 * 좌석 해제된 사람이 "대회가 끝났다"는 말을 보게 되고, 콘솔 화면(같은
 * 화면의 좌석 해제 안내, `ConsoleClient.tsx`)은 반대로 "다시 앉으라"고
 * 적고 있어 두 화면이 서로 어긋난다 — 그래서 어느 쪽이든 맞는 중립적인
 * 문구를 쓴다.
 *
 * 카운트다운이 끝나면 대기 화면(`/table?store=`)으로 돌아간다. 좌석
 * 토큰은 여기서 버려지는 게 아니라 — 다음 사람이 새 OTP로 다시 발급받을
 * 좌석 토큰이 이 자리를 덮어쓴다.
 */
export default function EliminatedOverlay({ storeId }: { storeId?: string }) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  /*
    **갈 곳을 모르면 가지 않는다.**

    `storeId`는 `page.tsx`의 `getTableContext`가 대회 조회로 구하는 값이고,
    그 조회가 실패하거나 스냅샷에 `tournamentId`가 없으면 `undefined`가 온다.
    그때 `/table?store=`로 보내면 대기 화면이 **"주소에 상점이 없습니다."**를
    띄운다(`(terminal)/table/page.tsx`) — 태블릿이 스스로 막다른 곳에 서고,
    거기서 돌아올 조작이 화면에 없다. 다음 손님이 앉을 자리다.

    머무는 편이 낫다. 화면에는 여전히 "이 자리에서 나왔습니다"가 떠 있어
    참가자는 할 일을 알고, 태블릿은 직원이 새로고침하면 낫는다.
  */
  const waitingUrl = storeId ? `/table?store=${storeId}` : null;

  useEffect(() => {
    if (!waitingUrl) return;
    if (secondsLeft <= 0) {
      router.push(waitingUrl);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, waitingUrl]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6">
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6 text-center">
        <p className="text-xs tracking-[0.14em] text-tb-act">수고하셨습니다</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">
          이 자리에서 나왔습니다
        </div>
        <p className="text-sm leading-relaxed text-tb-muted">
          순위·상금과 참가 OTP는 <strong className="text-tb-ink">폰에서 확인</strong>하세요.
        </p>

        {waitingUrl ? (
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
        ) : (
          // 돌아갈 주소를 못 구했다. 참가자에게 "기다리면 넘어간다"고 적을
          // 수 없고, 이 화면을 치우는 것은 이제 사람의 일이다.
          <div className="mt-4 text-xs text-tb-sub">
            다음 참가자를 위해 운영자에게 알려주세요.
          </div>
        )}
      </div>
    </div>
  );
}
