'use client';

import { useState } from 'react';
import { createStore } from '../action';

export default function NewStorePage() {
  const [error, setError] = useState<string | null>(null);

  async function clientAction(formData: FormData) {
    console.log("1. 클라이언트 액션 시작");
    try {
      const result = await createStore(formData);
      console.log("2. 서버 액션 결과 수신", result);
      if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      console.error("3. 에러 발생:", err);
    }
  }

  return (
    <main className="max-w-md mx-auto mt-10 p-6 bg-white shadow-lg rounded-xl">
      <h1 className="text-2xl font-bold mb-6">새 상점 등록</h1>

      <form action={clientAction} className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-medium">상점 이름</label>
          <input name="storeName" type="text" required className="w-full border p-2 rounded mt-1" placeholder="예: 플레이싱크 포커룸" />
        </div>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <button type="submit" className="bg-indigo-600 text-white py-2 rounded font-bold hover:bg-indigo-700 transition">
          상점 생성하기
        </button>
      </form>
    </main>
  );
}