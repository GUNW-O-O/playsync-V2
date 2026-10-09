'use client';

/**
 * 자동 재접속이 멈췄다 — **눌러야 돌아온다**(T119).
 *
 * 다시 붙는 중에는 위쪽 줄로 충분하다. 기다리면 낫고, 화면을 가릴 이유가 없다.
 * 재시도를 다 쓰고 멈춘 뒤에는 사람이 눌러야만 돌아오므로 화면을 덮는다 — 줄로
 * 두면 멈춘 화면을 정상으로 알고 계속 본다.
 */
export default function ReconnectOverlay({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-label="연결 끊김"
      className="fixed inset-0 z-50 flex items-center justify-center bg-tb-bg/90 p-6"
    >
      <div className="w-full max-w-[430px] border border-tb-line bg-tb-panel p-6 text-center">
        <p className="text-xs tracking-[0.14em] text-tb-act">연결 끊김</p>
        <div className="mb-3.5 mt-2 text-2xl font-light leading-snug text-tb-ink">
          서버에 연결하지 못했습니다
        </div>
        <p className="text-sm leading-relaxed text-tb-muted">
          자동으로 다시 연결하지 못했습니다. 아래 버튼을 눌러 다시 연결해 주세요.
        </p>
        <button
          type="button"
          data-testid="retry-now"
          onClick={onRetry}
          className="mt-5 block w-full border border-tb-line py-2.5 text-sm font-semibold text-tb-ink"
        >
          지금 다시 연결
        </button>
      </div>
    </div>
  );
}
