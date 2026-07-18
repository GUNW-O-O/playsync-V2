'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

const BACKEND_URL = process.env.BACKEND_URL;

export async function createTournamentAction(storeId: string, formData: FormData) {
  const cookieStore = await cookies();
  const token = cookieStore.get('accessToken')?.value;

  // 1. 블라인드 데이터 추출 (JSON 문자열을 파싱)
  const blindDataRaw = formData.get('blindData');
  const blindIdRaw = formData.get('blindId');

  const blindStructure = blindDataRaw ? JSON.parse(blindDataRaw as string) : undefined;
  const blindId = blindIdRaw ? JSON.parse(blindIdRaw as string) : undefined;

  // 2. 백엔드 DTO 규격에 맞게 조합
  const payload = {
    dto: {
      storeId: storeId,
      name: formData.get('name'),
      type: 'TOURNAMENT',
      entryFee: Number(formData.get('entryFee')),
      startStack: Number(formData.get('startStack')),
      rebuyUntil: Number(formData.get('rebuyUntil')),
      itmCount: Number(formData.get('itmCount')),
      blindId: blindId || undefined, // 기존 ID가 있으면 전송
    },
    // 새 블라인드 구조가 있으면 포함
    blindStructure: blindStructure || undefined
  };

  const res = await fetch(`${process.env.BACKEND_URL}/store/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const error = await res.json();
    return { error: error.message || '생성 실패' };
  }

  revalidatePath(`/store/${storeId}`);
  return { success: true };
}

// 대회 시작 (Patch)
export async function startTournament(storeId: string, tournamentId: string) {
  const token = (await cookies()).get('accessToken')?.value;

  const res = await fetch(`${BACKEND_URL}/store/sessions/${tournamentId}/start`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (res.ok) revalidatePath(`/store/${storeId}`);
  return res.ok;
}

// 대회 종료 (Patch)
export async function completeTournament(storeId: string, tournamentId: string) {
  const token = (await cookies()).get('accessToken')?.value;

  const res = await fetch(`${BACKEND_URL}/store/sessions/${tournamentId}/complete`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (res.ok) revalidatePath(`/store/${storeId}`);
  return res.ok;
}