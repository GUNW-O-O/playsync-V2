'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function joinTournament(tournamentId: string, tableId: string, seatIndex: number) {
  const cookie = await cookies();
  const token = cookie.get('accessToken')?.value;

  const res = await fetch(`${process.env.BACKEND_URL}/tournaments/payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      tournamentId,
      tableId,
      seatIndex
    })
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(error);
  }

  // 결제/참가 성공 시 나의 대회 현황 페이지 등으로 이동
  redirect(`/playsync`);
}
