/**
 * 상점 콘솔의 셸. 1440×900 데스크톱에서 읽힌다.
 *
 * **내비게이션을 두지 않는다.** 예전에는 `/stores`와 `/admin` 링크가 있었는데
 * 둘 다 라우트가 없어 404였다. 없는 곳으로 가는 링크는 스타일이 없는 것보다
 * 나쁘다 — 눌러 본 사람이 고장으로 읽는다. 라우트를 새로 만들지 않는 이유는
 * 이 면에서 카메라 앞에 서는 화면이 대회 상세 하나이기 때문이다
 * (`docs/superpowers/specs/2026-08-08-readme-demo-design.md`).
 *
 * 남기는 것은 Carbon의 top-nav 하나다 — 높이 48px, 캔버스 바탕, 1px 밑줄
 * (`DESIGN.md`). 링크가 아니라 이 면이 무엇인지를 알리는 표찰이다.
 *
 * 전광판은 여기 없다. `(board)` 그룹으로 옮겼다 — 이 내비를 상속하는 바람에
 * 순흑 화면 위에 흰 띠가 얹혀 있었다.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="flex h-12 items-center border-b border-[var(--hairline)] px-6">
        <span className="text-[14px] tracking-[0.16px]">
          <strong className="font-semibold">Playsync</strong>{' '}
          <span className="text-[var(--ink-subtle)]">상점 콘솔</span>
        </span>
      </header>
      <main>{children}</main>
    </div>
  );
}
