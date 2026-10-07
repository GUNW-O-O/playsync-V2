'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 등록 안 된 태블릿의 대기 화면(T112). 이 화면을 보는 사람은 태블릿을
 * 설치하는 직원이다 — 점주 계정을 넣으면 이 기기가 그 상점의 태블릿이 된다.
 */
export default function DeviceRegistration({
  storeId,
  register,
  notice,
}: {
  storeId: string;
  register: (input: { storeId: string; nickname: string; password: string }) => Promise<{ ok: true } | { error: string }>;
  notice?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setPending(true);
    setError(null);
    try {
      const result = await register({
        storeId,
        nickname: String(form.get('nickname') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if ('error' in result) setError(result.error);
      else router.refresh();
    } catch {
      setError('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-tb-bg p-8 text-tb-ink">
      <h1 className="text-xl font-semibold">매장 태블릿 등록</h1>
      <p>{notice ?? '이 기기는 아직 매장 태블릿으로 등록되지 않았습니다. 점주 계정으로 등록해 주세요.'}</p>
      {/* 공용 태블릿이라 점주 계정을 브라우저가 저장·자동완성하지 않게 한다. */}
      <form action={onSubmit} autoComplete="off" className="flex flex-col gap-2">
        <input name="nickname" autoComplete="off"aria-label="점주 아이디" placeholder="점주 아이디" required className="border px-3 py-2" />
        <input name="password" autoComplete="new-password"aria-label="비밀번호" type="password" placeholder="비밀번호" required className="border px-3 py-2" />
        <button type="submit" disabled={pending} className="border px-3 py-2">
          {pending ? '등록 중…' : '이 기기 등록'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
