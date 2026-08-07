'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 폰 하단 탭.
 *
 * 클라이언트인 이유는 **지금 어느 탭인지**를 경로에서 읽기 때문이다. 그
 * 판단을 각 페이지에 넘기면 화면을 하나 더 만들 때마다 탭 상태를 다시
 * 전달해야 하고, 빠뜨린 화면은 조용히 아무 탭도 켜지지 않은 채로 뜬다.
 *
 * 선택 표시는 Carbon의 `product-tab-selected`를 그대로 쓰되 **파랑 2px을
 * 위에** 둔다(`DESIGN.md`는 밑줄로 적는다). 하단 바에서는 밑줄이 화면
 * 가장자리에 붙어 잘려 보인다 — 본문에 닿는 쪽이 위다.
 */
const TABS = [
  { href: '/tournaments', label: '대회' },
  { href: '/me', label: '내 정보' },
] as const;

export default function PlayerTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="주요 메뉴"
      className="grid shrink-0 grid-cols-2 border-t border-[var(--hairline)] bg-[var(--canvas)]"
    >
      {TABS.map((tab) => {
        // `/tournaments/<id>`도 대회 탭이다. 정확히 일치로만 보면 상세를
        // 여는 순간 두 탭이 다 꺼진다.
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            // Carbon 터치 타깃 48px(`DESIGN.md` Touch Targets).
            className={`flex h-12 items-center justify-center border-t-2 text-[14px] tracking-[0.16px] transition-colors ${
              active
                ? 'border-[var(--blue)] font-semibold text-[var(--ink)]'
                : 'border-transparent text-[var(--ink-muted)]'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
