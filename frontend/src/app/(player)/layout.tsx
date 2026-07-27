import Link from 'next/link';

export default function PlayerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <main>{children}</main>
      <nav aria-label="주요 메뉴">
        <Link href="/tournaments">대회</Link>
        <Link href="/me">내 정보</Link>
      </nav>
    </div>
  );
}
