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
  // 딜러 여부만 서버에서 판정해 내린다. 토큰 자체는 내리지 않는다 — prop은
  // RSC 페이로드로 직렬화되어 페이지 소스에 그대로 남기 때문이다.
  const isDealer = initialData.seatIndex === -1 && !!cookieStore.get('dealerToken');

  return (
    <main className="h-screen bg-slate-900 overflow-hidden">
      {initialData ? (
        <GameClient
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