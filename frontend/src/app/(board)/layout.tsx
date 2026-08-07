/**
 * 전광판. **크롬이 없다.**
 *
 * `(console)` 그룹 안에 있던 것을 여기로 옮겼다. 콘솔 레이아웃의 내비를
 * 상속하는 바람에 순흑 화면 맨 위에 흰 띠가 얹혀 있었고, 10m 밖에서 읽히라고
 * 만든 면이 브라우저 크롬을 달고 있었다.
 *
 * 라우트 그룹은 URL에 나타나지 않으므로 주소
 * (`/stores/:storeId/tournaments/:id/display`)도, 미들웨어의 `/stores` 역할
 * 규칙도 그대로다. 바뀌는 것은 어느 레이아웃을 상속하느냐뿐이다.
 *
 * 전광판은 대회 내내 틀어 두는 화면이라 사람이 누를 것이 없다. 그래서
 * 내비게이션을 두지 않는다 — 좌석·딜러 단말(`(terminal)`)과 같은 이유다.
 */
export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
