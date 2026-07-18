// src/app/playsync/page.tsx (Server Component)
import { cookies } from 'next/headers';
import Link from 'next/link';

async function getMyJoinedTables() {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value || cookieStore.get('accessToken')?.value;

  if (!token) {
    console.error("인증 토큰이 없습니다.");
  }
  // 백엔드: GET /tournaments/my-tables (본인이 속한 TablePlayer 목록 반환)
  const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/playsync`, {
    headers: { 'Authorization': `Bearer ${token}` },
    cache: 'no-store'
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function PlaySyncMain() {
  const tables = await getMyJoinedTables();
  if (!tables || tables.length === 0) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">내 게임 목록</h1>
        <div className="space-y-4">
          <p>아직 토너먼트가 준비되지 않았습니다.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">내 게임 목록</h1>
      <div className="space-y-4">
        {tables.length > 0 && tables[0].userId ? tables.map((item: any) => (
          <Link
            key={item.tableId}
            href={`/playsync/${item.tableId}`}
            className="block p-5 border rounded-2xl bg-white hover:border-indigo-500 transition shadow-sm"
          >
            <div className="flex justify-between items-center">
              <div>
                <p className="font-bold text-gray-500 text-lg">{item.tournament.name}</p>
                <p className="text-sm text-gray-500">{item.table.tableOrder}번 테이블 - {item.seatPosition + 1}번석</p>
              </div>
              <span className="text-indigo-600 font-bold">입장하기 →</span>
            </div>
          </Link>
        )) : (
          (tables[0].dealerId && tables[0].tableOrder) ? (
            <Link
              key={tables[0].id}
              href={`/playsync/${tables[0].id}`}
              className="block p-5 border rounded-2xl bg-white hover:border-indigo-500 transition shadow-sm"
            >
              <div className="flex justify-between items-center">
                <span className="text-indigo-600 font-bold">{tables[0].tableOrder}번 테이블 딜러 입장하기 →</span>
              </div>
            </Link>
          ) : (
            <p>아직 토너먼트가 준비되지 않았습니다.</p>
          )
        )}
      </div>
    </div>
  );
}