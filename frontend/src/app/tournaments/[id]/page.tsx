import { cookies } from 'next/headers';
import TournamentClient from './TournamentClient';

async function getInitialTablesData(id: string) {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value || cookieStore.get('accessToken')?.value;

  if (!token) {
    console.error("인증 토큰이 없습니다.");
  }
  const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tournaments/${id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    cache: 'no-store'
  });
  return res.json();
}

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initialData = await getInitialTablesData(id);
  const cookie = await cookies();
  const token = cookie.get('accessToken')?.value || '';

  if(!initialData) return (
    <div>
      데이터를 불러올 수 없습니다.
    </div>
  );

  return (
    <TournamentClient
      initialData={initialData} 
      id={id} 
      token={token}
    />
  );
}