import PlayerTabs from './PlayerTabs';

/**
 * 참가자 폰의 셸. 390×844에서 읽힌다.
 *
 * 높이를 `100dvh`로 잡고 세 칸(머리 · 본문 · 탭)으로 나눈다. 예전에는
 * 감싸는 것이 `<div>` 하나뿐이었고 각 페이지가 `min-h-screen`을 걸어서,
 * **탭이 화면 아래로 밀려나 스크롤해야 나왔다.** 폰에서 내비게이션이
 * 접힌 곳에 있으면 없는 것과 같다.
 *
 * `dvh`인 이유는 모바일 브라우저의 주소창이다. `vh`는 주소창이 접힌
 * 상태의 높이라 펼쳐져 있는 동안 탭이 잘린다.
 */
export default function PlayerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] flex-col bg-[var(--canvas)] text-[var(--ink)]">
      {/* Carbon top-nav — 높이 48px, 캔버스 바탕, 1px 밑줄(`DESIGN.md`). */}
      <header className="flex h-12 shrink-0 items-center border-b border-[var(--hairline)] px-6">
        <span className="text-[14px] font-semibold tracking-[0.16px]">Playsync</span>
      </header>

      {/* 스크롤은 여기서만 일어난다. 그래야 탭이 늘 제자리에 있다. */}
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

      <PlayerTabs />
    </div>
  );
}
