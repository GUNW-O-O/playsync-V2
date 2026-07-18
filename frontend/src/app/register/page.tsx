'use client';

import { useState } from 'react';
import { handleRegister } from '../auth/action';

export default function RegisterPage() {
  const [error, setError] = useState<string | null>(null);

  // 클라이언트 측 유효성 검사 및 액션 실행
  async function clientAction(formData: FormData) {
    const password = formData.get('password') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (password !== confirmPassword) {
      setError('비밀번호가 일치하지 않습니다.');
      return;
    }

    const result = await handleRegister(formData);
    if (result?.error) {
      setError(result.error);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="w-full max-w-md bg-white p-8 rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6 text-center">회원가입</h1>
        
        <form action={clientAction} className="flex flex-col gap-4">

          <div>
            <label className="block text-sm font-medium text-gray-900">아이디</label>
            <input name="nickname" type="nickname" required className="mt-1 block w-full border border-gray-300 rounded-md p-2 shadow-sm focus:ring-blue-500 focus:border-blue-500" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-900">비밀번호</label>
            <input name="password" type="password" required className="mt-1 block w-full border border-gray-300 rounded-md p-2 shadow-sm focus:ring-blue-500 focus:border-blue-500" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-900">비밀번호 확인</label>
            <input name="confirmPassword" type="password" required className="mt-1 block w-full border border-gray-300 rounded-md p-2 shadow-sm focus:ring-blue-500 focus:border-blue-500" />
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button type="submit" className="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded hover:bg-blue-700 transition-colors">
            가입하기
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-600">
          이미 계정이 있으신가요? <a href="/login" className="text-blue-600 hover:underline">로그인</a>
        </p>
      </div>
    </main>
  );
}