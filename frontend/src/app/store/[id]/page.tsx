import { cookies } from 'next/headers';
import Link from 'next/link';
import TournamentForm from './TournamentForm';
import { completeTournament, startTournament } from './action';

const BACKEND_URL = process.env.BACKEND_URL;
async function getStoreData(id: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get('accessToken')?.value;

  const res = await fetch(`${BACKEND_URL}/store/${id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    next: { revalidate: 0 },
  });

  if (!res.ok) return null;
  return res.json();
}
async function getStoreTournament(id: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get('accessToken')?.value;

  const res = await fetch(`${BACKEND_URL}/store/sessions/${id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    next: { revalidate: 0 },
  });

  if (!res.ok) return null;
  return res.json();
}

export default async function StoreDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const id = resolvedParams.id;
  const store = await getStoreData(id);
  const tournaments = await getStoreTournament(id);
  if (!store) return <div>상점을 찾을 수 없습니다.</div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <header className="mb-8 border-b pb-4">
        <h1 className="text-3xl font-bold">{store.name}</h1>
        <p className="text-gray-500">상점 관리자 페이지</p>
      </header>

      {/* 대회 목록 섹션 */}
      <section className="mb-12">
        <h2 className="text-xl font-semibold mb-4">현재 진행/예정 대회</h2>
        {tournaments?.length > 0 ? (
          <div className="grid gap-4">
            {tournaments.map((t: any) => (
              <div key={t.id} className="p-5 border rounded-xl shadow-sm bg-gray-700 flex justify-between items-center mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-lg">{t.name}</h3>
                    {/* 상태 배지 (예시) */}
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${t.status === 'ONGOING' ? 'bg-green-100 text-green-700' :
                        t.status === 'FINISHED' ? 'bg-gray-100 text-gray-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                      {t.status}
                    </span>
                    <span>남은인원 : {t.activePlayers}/{t.totalPlayers}</span>
                  </div>
                  <p className="text-sm text-gray-500">OTP: <span className="font-mono font-bold text-indigo-600">{t.dealerOtp}</span></p>
                </div>

                <div className="flex gap-2">
                  {/* 상세보기 버튼 */}
                  <Link
                    href={`/dashboard/${t.id}`}
                    className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-gray-50"
                  >
                    전광판
                  </Link>

                  {/* 시작/종료 버튼 (상태에 따라 분기 처리하면 더 좋습니다) */}
                  {t.status !== 'FINISHED' && (
                    <>
                      <form action={async () => {
                        'use server';
                        await startTournament(id, t.id);
                      }}>
                        <button className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700">
                          시작
                        </button>
                      </form>

                      <form action={async () => {
                        'use server';
                        await completeTournament(id, t.id);
                      }}>
                        <button className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700">
                          종료
                        </button>
                      </form>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-gray-50 p-10 text-center rounded-lg border-2 border-dashed">
            <p className="text-gray-500 mb-4">등록된 대회가 없습니다.</p>
          </div>
        )}
      </section>

      {/* 대회 생성 폼 섹션 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* 대회 및 블라인드 통합 생성 폼 */}
        <div className="bg-white p-6 rounded-xl shadow-lg border">
          <h2 className="text-xl text-gray-700 font-bold mb-6">대회 및 블라인드 설정</h2>
          <TournamentForm storeId={id} savedBlinds={store.blindStructures} />
        </div>
      </div>
    </div>
  );
}