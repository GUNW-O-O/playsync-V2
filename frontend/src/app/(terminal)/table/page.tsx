import WaitingClient from './WaitingClient';
import { enterSeat } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function json(path: string) {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

/** `WaitingClient`의 `Tournament`·`Table` 타입과 같은 모양이다. */
type TournamentSummary = { id: string; name: string; status: string };
type TableSummary = { id: string; tableOrder: number };

/**
 * 이 페이지는 가드 없는 공개 라우트다(대기 태블릿, 로그인 전 기기). 백엔드
 * 행을 통째로 클라이언트 컴포넌트에 넘기면 RSC 페이로드에 그대로
 * 직렬화된다 — TS 타입(`WaitingClient`의 `Tournament`/`Table`)이 좁아도
 * 그건 컴파일 시점 계약일 뿐, 여기서 필드를 직접 고르지 않으면 런타임
 * 페이로드는 조회 응답 전체가 된다. 지금은 `omit`(dealerOtpHash)이 비밀을
 * 막고 있지만, 그 경계를 select 하나에만 기대지 않는다.
 */
function toTournamentSummary(row: { id: string; name: string; status: string }): TournamentSummary {
  return { id: row.id, name: row.name, status: row.status };
}

function toTableSummary(row: { id: string; tableOrder: number }): TableSummary {
  return { id: row.id, tableOrder: row.tableOrder };
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

  const tournamentRows = (await json(`/tournaments/stores/${store}`)) ?? [];
  const tournaments = (tournamentRows as { id: string; name: string; status: string }[]).map(
    toTournamentSummary,
  );
  const current = tournaments[0] ?? null;
  const session = current ? await json(`/dealer/${current.id}`) : null;
  const tables = ((session?.tables ?? []) as { id: string; tableOrder: number }[]).map(
    toTableSummary,
  );
  const seatMap = current ? ((await json(`/tournaments/${current.id}/seats`)) ?? []) : [];

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      <WaitingClient
        storeId={store}
        tournaments={tournaments}
        tables={tables}
        seatMap={seatMap}
        enterSeat={enterSeat}
      />
    </main>
  );
}
