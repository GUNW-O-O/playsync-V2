import Link from 'next/link';

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <nav aria-label="콘솔 메뉴">
        <ul>
          <li>
            <Link href="/stores">상점</Link>
          </li>
          <li>
            <Link href="/admin">플랫폼 관리</Link>
          </li>
        </ul>
      </nav>
      <main>{children}</main>
    </div>
  );
}
