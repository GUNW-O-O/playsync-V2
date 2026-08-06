import { cookies } from 'next/headers';
import DealerGameClient from './DealerGameClient';

/**
 * `GET /playsync/:tableId`(`playsync.controller.ts`의 `joinTable`)는
 * `req.user.userId`로 좌석 인덱스를 찾는다. 딜러 JWT는 `JwtStrategy`가
 * `id`로 내보내고 `userId`는 채우지 않으므로(`jwt.strategy.ts` DEALER 분기),
 * 서비스가 받는 `userId`는 `undefined`고 `joinTable`이 `seatIndex: -1`을
 * 돌려준다 — 딜러는 애초에 좌석이 없으므로 그 값을 화면에서 쓰지 않는다.
 */
async function getInitialGameData(tableId: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value;

  if (!token) {
    console.error('인증 토큰이 없습니다.');
  }
  const res = await fetch(`${process.env.BACKEND_URL}/playsync/${tableId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  return res.json();
}

export default async function DealerGamePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  const initialData = await getInitialGameData(tableId);

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      {initialData ? (
        <DealerGameClient tableId={tableId} initialData={initialData.tableState} />
      ) : (
        <p>아직 게임이 시작되지 않았습니다.</p>
      )}
    </main>
  );
}
