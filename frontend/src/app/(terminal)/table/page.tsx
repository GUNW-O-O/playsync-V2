import WaitingClient from './WaitingClient';
import { enterSeat } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function json(path: string) {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

/**
 * 좌석 태블릿의 기본 상태. 아는 것은 URL의 `?store=`뿐이다 — 대회가 바뀌어도
 * 기기를 손댈 것이 없다(`docs/*` 대신 와이어프레임 638–643행 근거).
 *
 * 세 번 조회한다: 상점의 대회 목록, 대회의 테이블 목록, 좌석 점유 현황.
 * 좌석 현황만 `WaitingClient`가 5초마다 다시 읽는다 — 나머지는 이 화면에
 * 머무는 동안 거의 바뀌지 않는다.
 */
export default async function SeatWaitingPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const { store } = await searchParams;
  if (!store) return <main className="p-8 text-tb-ink">?store= 가 필요합니다.</main>;

  const tournaments = (await json(`/tournaments/stores/${store}`)) ?? [];
  const current = tournaments[0] ?? null;
  const session = current ? await json(`/dealer/${current.id}`) : null;
  const seatMap = current ? ((await json(`/tournaments/${current.id}/seats`)) ?? []) : [];

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      <WaitingClient
        storeId={store}
        tournaments={tournaments}
        tables={session?.tables ?? []}
        seatMap={seatMap}
        enterSeat={enterSeat}
      />
    </main>
  );
}
