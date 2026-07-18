import { cookies } from 'next/headers';
import GameClient from './GameClient';

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

export default async function GamePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  const initialData = await getInitialGameData(tableId);
  const cookieStore = await cookies();
  const dealerToken = cookieStore.get('dealerToken')?.value;
  const accessToken = cookieStore.get('accessToken')?.value;
  const token = dealerToken || accessToken || "";
  let isDealer = false;
  // !! = 강제 불리언형변환
  if(initialData.seatIndex === -1 && !!dealerToken) {
    isDealer = true;
  }
  return (
    <main className="h-screen bg-slate-900 overflow-hidden">
      {initialData ? (
        <GameClient
          token={token}
          initIsDealer={isDealer}
          tableId={tableId}
          initialData={initialData.tableState}
          seatIndex={initialData.seatIndex}
        />
      ) : (
        <p>아직 게임이 시작되지 않았습니다.</p>
      )}
    </main>
  );
}