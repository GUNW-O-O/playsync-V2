export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 단말은 좌석과 딜러석에 고정된 전체화면이다. 네비게이션을 두지 않는다.
  return <div>{children}</div>;
}
