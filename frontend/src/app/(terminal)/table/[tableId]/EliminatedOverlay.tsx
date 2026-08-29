'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 와이어프레임 904–905행 "7초 뒤 대기 화면으로 돌아갑니다". */
const COUNTDOWN_SECONDS = 7;

/**
 * 이 좌석에서 이 사람이 빠진 **사유**.
 *
 * `SeatGameClient`가 정한다 — 서버는 어느 쪽인지 말해 주지 않고, 둘 다
 * `renderGame`의 내 자리가 `null`로만 온다.
 */
export type ExitReason = 'eliminated' | 'seat-released';

/**
 * 계기마다 다른 말을 한다.
 *
 * **전에는 하나로 덮었다.** 두 계기 어디에도 안 틀린 문구를 찾다가
 * 「이 자리에서 나왔습니다」가 됐는데, 그 중립의 대가가 **아무에게도
 * 아무 말도 안 하는 문장**이었다 — 탈락한 사람은 자기가 끝났는지 모르고,
 * 자리를 옮겨야 하는 사람은 걸어가야 한다는 걸 모른다. 두 상황은
 * 정반대다: 한쪽은 대회가 끝난 것이고 다른 쪽은 **칩을 든 채** 다른
 * 자리로 가는 것이다(T29).
 *
 * 좌석 해제 문구는 상점 콘솔이 같은 순간에 띄우는 안내와 같은 말이다
 * (`ConsoleClient`의 "새 자리에서 참가 OTP를 다시 넣습니다"). 두 화면이
 * 다른 말을 하면 참가자가 직원에게 되묻는다.
 */
const COPY: Record<ExitReason, { badge: string; title: string; body: React.ReactNode }> = {
  eliminated: {
    badge: '탈락',
    title: '칩이 0이 되어 대회에서 나왔습니다',
    body: (
      <>
        폰의 <strong className="text-tb-ink">「지난 참가」</strong>에서 순위와 상금을
        확인하세요.
      </>
    ),
  },
  'seat-released': {
    badge: '자리 이동',
    title: '자리를 이동해 주세요',
    body: (
      <>
        <strong className="text-tb-ink">칩은 그대로입니다.</strong> 새 자리로 가서 참가 OTP를
        다시 넣으세요.
      </>
    ),
  },
};

/**
 * 이 좌석에서 이 사람이 빠졌을 때 화면을 덮는다(와이어프레임 885–922행).
 * 순위·상금은 그리지 않는다 — 이 기기는 다음 사람이 앉을 자리라, 사람에게
 * 붙는 정보(폰의 `GET /user/me/participations`)를 여기 남겨 둘 이유가 없다.
 *
 * 카운트다운이 끝나면 대기 화면(`/table?store=`)으로 돌아간다. 좌석
 * 토큰은 여기서 버려지는 게 아니라 — 다음 사람이 새 OTP로 다시 발급받을
 * 좌석 토큰이 이 자리를 덮어쓴다.
 */
export default function EliminatedOverlay({
  storeId,
  reason,
}: {
  storeId?: string;
  reason: ExitReason;
}) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  /*
    **갈 곳을 모르면 가지 않는다.**

    `storeId`는 `page.tsx`의 `getTableContext`가 대회 조회로 구하는 값이고,
    그 조회가 실패하거나 스냅샷에 `tournamentId`가 없으면 `undefined`가 온다.
    그때 `/table?store=`로 보내면 대기 화면이 **"주소에 상점이 없습니다."**를
    띄운다(`(terminal)/table/page.tsx`) — 태블릿이 스스로 막다른 곳에 서고,
    거기서 돌아올 조작이 화면에 없다. 다음 손님이 앉을 자리다.

    머무는 편이 낫다. 화면에는 여전히 무슨 일이 있었는지가 떠 있어
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
        {/*
          **머리글이 곧 「왜 떴는가」다.** 여기에 "수고하셨습니다"가 있었다 —
          화면에서 가장 먼저 읽히는 줄을 인사말이 차지하니 사유가 갈 자리가
          없어졌고, 그래서 제목이 그 몫까지 떠맡아 중립어가 됐다.
          `RebuyOverlay`만 이 자리에 사건을 넣고("칩이 떨어졌습니다") 그래서
          그것만 읽혔다.
        */}
        <p className="text-xs tracking-[0.14em] text-tb-act">{COPY[reason].badge}</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">
          {COPY[reason].title}
        </div>
        <p className="text-sm leading-relaxed text-tb-muted">{COPY[reason].body}</p>

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
