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
 * 없다 — 테이블 상태는 매장을 모른다. `TableState.tournamentId`로 대회
 * 정보(`GET /tournaments/:id`, `storeId` 포함)를 한 번 더 불러 얻는다.
 */
async function getStoreId(tournamentId: string | undefined): Promise<string | undefined> {
  if (!tournamentId) return undefined;
  const res = await fetch(`${process.env.BACKEND_URL}/tournaments/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return undefined;
  const tournament = await res.json().catch(() => null);
  return (tournament as { storeId?: string } | null)?.storeId;
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
