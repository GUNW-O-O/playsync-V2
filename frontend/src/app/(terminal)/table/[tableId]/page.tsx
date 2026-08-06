import { cookies } from 'next/headers';
import SeatGameClient from './SeatGameClient';

async function getInitialGameData(tableId: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value || cookieStore.get('accessToken')?.value;

  if (!token) {
    console.error("인증 토큰이 없습니다.");
  }
  const res = await fetch(`${process.env.BACKEND_URL}/playsync/${tableId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    cache: 'no-store'
  });
  return res.json();
}

/**
 * 대기 화면(`/table?store=`)으로 돌아갈 때 쓸 매장 id를 구한다.
 *
 * `GET /playsync/:tableId`(위 `getInitialGameData`) 응답에는 storeId가
 * 없다 — 테이블 상태는 매장을 모른다. `TableState.tournamentId`(Redis
 * 스냅샷에 실제로 실려 온다 — `entry.service.ts`의 `emptyTableState`,
 * `recovery.service.ts`가 세울 때부터 채운다)로 대회 정보를 한 번 더
 * 불러 얻는다.
 *
 * `GET /tournaments/:id`(`payment.service.ts`의 `getTournamentInfo`)는
 * `{ tournament, seatStatus }` 봉투로 온다. `storeId`는 `tournament.storeId`에
 * 있다 — 봉투째로 캐스팅해 최상위에서 읽으면 항상 undefined가 된다(리뷰 지적).
 *
 * 이 조회가 실패해도 게임 화면 자체를 죽이지 않는다 — 탈락 복귀 주소를
 * 못 구할 뿐이고, 그 정도로 화면 전체가 500이 되는 건 균형이 안 맞는다.
 */
async function getStoreId(tournamentId: string | undefined): Promise<string | undefined> {
  if (!tournamentId) return undefined;
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/tournaments/${tournamentId}`, { cache: 'no-store' });
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as { tournament?: { storeId?: string } } | null;
    return body?.tournament?.storeId;
  } catch (err) {
    console.error('대회 정보를 불러오지 못해 storeId를 구하지 못했습니다.', err);
    return undefined;
  }
}

export default async function GamePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  const initialData = await getInitialGameData(tableId);
  const storeId = await getStoreId(initialData?.tableState?.tournamentId);

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      {initialData ? (
        <SeatGameClient
          tableId={tableId}
          initialData={initialData.tableState}
          seatIndex={initialData.seatIndex}
          storeId={storeId}
        />
      ) : (
        <p>아직 게임이 시작되지 않았습니다.</p>
      )}
    </main>
  );
}
