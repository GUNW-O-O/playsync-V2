'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClosedTournamentStatus } from '@playsync/contract';

/** 좌석의 `EliminatedOverlay`와 같은 값을 쓴다. 같은 종류의 기다림이다. */
const COUNTDOWN_SECONDS = 7;

/**
 * 대회가 닫혔을 때 단말을 덮는다. **딜러 태블릿과 좌석 태블릿이 같이 쓴다.**
 *
 * ── 왜 필요했나
 *
 * 대회를 닫는 네 경로(`completeSession` · `chopSession` · `abortSession` ·
 * `cancelSession`)가 소켓에 아무것도 쓰지 않아서, 두 화면 모두 끝난 대회의
 * 마지막 스냅샷을 계속 그렸다. 딜러가 「핸드 시작」을 누르면 `Table` 행도
 * Redis 스냅샷도 없어 서비스가 던지고, 딜러가 보는 것은 **「명령이
 * 거절되었습니다」** 하나였다 — 끝났다는 사실이 아니라 정체불명의 에러다.
 *
 * ── 왜 덮나
 *
 * **버튼을 비활성으로 두는 것으로는 부족하다.** 단말 앞의 사람이 보는 것은
 * 펠트이고, 회색이 된 버튼은 「지금은 차례가 아니다」와 같은 모양이라 왜
 * 안 눌리는지가 어디에도 안 적힌다.
 *
 * ── 왜 하나인가
 *
 * 두 단말이 **같은 사건**을 본다. 다른 것은 돌아갈 대기 화면과 한 문장뿐이고,
 * 그 둘을 각자 들고 있으면 한쪽 문구만 고쳐지는 날이 온다 — 그때 딜러와
 * 참가자가 같은 대회에 대해 다른 말을 읽는다.
 *
 * **순위와 상금은 그리지 않는다.** 그것은 참가자 폰(`/me`)에 붙는 정보이고,
 * 두 태블릿이 할 일은 다음 대회를 위해 대기 화면으로 돌아가는 것이다 —
 * `EliminatedOverlay`가 좌석에서 같은 판단을 한다.
 */
export default function TournamentClosedOverlay({
  status,
  storeId,
  terminal,
}: {
  status: ClosedTournamentStatus;
  /** 없으면 대기 화면 안내를 빼고 머문다. 아래 `waitingUrl` 주석. */
  storeId?: string;
  terminal: 'dealer' | 'seat';
}) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  /*
    **갈 곳을 모르면 가지 않는다.** `EliminatedOverlay`와 같은 판단이다 —
    `storeId` 없이 대기 화면으로 보내면 그쪽이 "주소에 상점이 없습니다"를
    띄우고(`(terminal)/dealer/page.tsx` · `(terminal)/table/page.tsx`),
    거기서 돌아올 조작이 화면에 없다. 단말이 스스로 막다른 곳에 선다.

    머무는 편이 낫다. 화면에는 여전히 대회가 끝났다는 문장이 떠 있어 사람은
    할 일을 알고, 태블릿은 직원이 새로고침하면 낫는다.
  */
  const waitingUrl = storeId
    ? `${terminal === 'dealer' ? '/dealer' : '/table'}?store=${storeId}`
    : null;

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

  /*
    **종료와 중단은 다른 문장이다.**

    종료는 걷은 참가비가 상금과 상점 몫으로 다 나간 것이고, 중단은 환불하고
    무른 것이다. 딜러가 테이블 앞에서 안내해야 하는 말과 참가자가 확인해야
    하는 것이 다르므로, 같은 문구로 덮으면 그 구분이 화면에서 사라진다.
  */
  const aborted = status === 'CANCELLED';

  return (
    <div
      data-testid={`${terminal}-tournament-closed`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6"
    >
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6 text-center">
        <p className="text-xs tracking-[0.14em] text-tb-act">수고하셨습니다</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">
          대회가 끝났습니다
        </div>
        <p className="text-sm leading-relaxed text-tb-muted">
          {aborted ? (
            <>
              운영이 대회를 <strong className="text-tb-ink">중단</strong>했습니다. 참가비는
              환불되었습니다.
            </>
          ) : (
            <>정산이 끝나 대회가 닫혔습니다.</>
          )}{' '}
          {terminal === 'dealer' ? (
            <>
              순위·상금은 <strong className="text-tb-ink">참가자 폰</strong>에 있습니다.
            </>
          ) : (
            <>
              순위·상금은 <strong className="text-tb-ink">폰에서 확인</strong>하세요.
            </>
          )}
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
          // 돌아갈 주소를 못 구했다. 이 화면을 치우는 것은 이제 사람의 일이다.
          <div className="mt-4 text-xs text-tb-sub">
            다음 대회를 위해 운영자에게 알려주세요.
          </div>
        )}
      </div>
    </div>
  );
}
