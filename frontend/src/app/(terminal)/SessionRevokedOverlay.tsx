'use client';

import Link from 'next/link';

/**
 * 서버가 이 기기의 좌석·딜러 신원을 폐기했을 때 단말을 덮는다(T110).
 *
 * 폐기된 토큰으로는 다시 붙어도 티켓이 403이라 `useTableSocket`이 재접속을
 * 멈춘다 — 그 자리에 「새로고침」 문구만 남기면 사람이 할 일을 모른다. 이유와
 * 돌아갈 길(대기 화면)을 적는다. **좌석과 딜러 단말이 같이 쓴다.**
 *
 * `href`가 없으면(`storeId`를 못 구한 경우) 링크 없이 머문다 —
 * `EliminatedOverlay`의 `waitingUrl`과 같은 판단이다.
 */
export default function SessionRevokedOverlay({
  reason,
  hint,
  href,
}: {
  reason: string;
  hint: string;
  href?: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="접속 해제"
      className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6"
    >
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6 text-center">
        <p className="text-xs tracking-[0.14em] text-tb-act">접속 해제</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">{reason}</div>
        <p className="text-sm leading-relaxed text-tb-muted">{hint}</p>
        {href && (
          <Link
            href={href}
            className="mt-5 block w-full border border-tb-line py-2.5 text-sm text-tb-muted"
          >
            대기 화면으로
          </Link>
        )}
      </div>
    </div>
  );
}
