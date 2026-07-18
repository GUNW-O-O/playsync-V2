'use client';

import { useState } from 'react';
import { handleLogin } from '../auth/action';
import Link from 'next/link';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);

  async function clientAction(formData: FormData) {
    const result = await handleLogin(formData);
    if (result?.error) {
      setError(result.error);
    }
  }

  return (
    <div className="flex flex-col items-center mt-20">
      <h1 className="text-2xl font-bold mb-4">로그인</h1>
      <form action={clientAction} className="flex flex-col gap-3 w-80 mb-2">
        <input name="nickname" type="nickname" placeholder="Nickname" required className="border p-2 rounded" />
        <input name="password" type="password" placeholder="Password" required className="border p-2 rounded" />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <button type="submit" className="bg-blue-500 text-white p-2 rounded hover:bg-blue-600">
          로그인
        </button>
      </form>
      <div className='flex flex-row items-center gap-3 w-80'>
        <Link
          href={`/register`} className="flex-1 flex justify-center items-center bg-blue-500 text-white p-2 rounded hover:bg-blue-600">
          회원가입
        </Link>
        <Link
          href={`/register`} className="flex-1 flex justify-center items-center bg-blue-500 text-white p-2 rounded hover:bg-blue-600">
          가맹 회원가입
        </Link>
      </div>
    </div>
  );
}