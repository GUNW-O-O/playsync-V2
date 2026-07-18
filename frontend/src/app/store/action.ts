'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

const BACKEND_URL = process.env.BACKEND_URL;

// [공통 함수] 헤더에 토큰 담기
async function getAuthHeaders() {
  const cookie = await cookies();
  const token = cookie.get('accessToken')?.value;
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

export async function getMyStores() {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/store`, { headers });

  if (!res.ok) return [];
  return res.json();
}

export async function createStore(formData: FormData) {
  const cookie = await cookies();
  const token = cookie.get('accessToken')?.value;

  if (!token) {
    return { error: '로그인이 필요합니다.' };
  }

  // 2. 폼 데이터 추출
  const storeName = formData.get('storeName');
  console.log("백엔드 요청 주소:", `${BACKEND_URL}/store`);

  // 3. NestJS 백엔드로 상점 생성 요청
  const res = await fetch(`${BACKEND_URL}/store`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`, // 백엔드 Guard에서 이걸로 유저 식별
    },
    body: JSON.stringify({ storeName }),
  });

  // const data = await res.json();

  // if (!res.ok) {
  //   return { error: data.message || '상점 생성에 실패했습니다.' };
  // }
  if (!res.ok) {
    const errorText = await res.text(); // json() 대신 text()로 생 에러 확인
    console.log("백엔드가 보낸 에러 원문:", errorText);
    return { error: errorText };
  }

  // 4. 생성 성공 시 상점 목록 페이지(또는 관리 페이지)로 이동
  redirect('/store');
}

export async function createTournament(storeId: string, formData: FormData) {
  const headers = await getAuthHeaders();
  const rawData = Object.fromEntries(formData);

  const res = await fetch(`${BACKEND_URL}/store/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: rawData.title,
      entryFee: Number(rawData.entryFee),
      // 블라인드 구조 등 추가 데이터
    }),
  });

  if (!res.ok) return { error: '토너먼트 생성 실패' };

  // 데이터가 변했으므로 페이지 캐시 갱신
  revalidatePath(`/store/${storeId}`);
  return { success: true };
}