'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { handleLogin } from '../auth/action';
import Field from '../auth/Field';

/**
 * 로그인 폼.
 *
 * 이 문은 폰과 상점 콘솔이 함께 쓴다. 그래서 폰 셸(`(player)/layout.tsx`)
 * 밖에 있고, 어느 쪽에서 열어도 읽히도록 가운데 한 칸으로만 세운다.
 *
 * `next`는 미들웨어가 붙여 준 원래 가려던 경로다. 서버 액션에 폼 필드로
 * 넘긴다 — 액션은 요청 URL을 볼 수 없다.
 */
export default function LoginForm({ next }: { next?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function clientAction(formData: FormData) {
    startTransition(async () => {
      const result = await handleLogin(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-[400px] flex-col gap-8 p-6 pt-16">
      <div className="flex flex-col gap-2">
        <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-subtle)]">
          Playsync
        </p>
        <h1 className="text-[28px] font-light leading-[1.2]">로그인</h1>
      </div>

      <form action={clientAction} className="flex flex-col gap-6">
        {next && <input type="hidden" name="next" value={next} />}

        <Field
          name="nickname"
          label="닉네임"
          type="text"
          autoComplete="username"
        />
        <Field
          name="password"
          label="비밀번호"
          type="password"
          autoComplete="current-password"
        />

        {error && (
          <p
            role="alert"
            className="border-l-2 border-[var(--err)] bg-[var(--surface)] px-4 py-3 text-[14px] leading-[1.29] tracking-[0.16px]"
          >
            {error}
          </p>
        )}

        {/* Carbon button-primary. */}
        <button
          type="submit"
          disabled={pending}
          className="h-12 w-full bg-[var(--blue)] px-4 text-[14px] tracking-[0.16px] text-white transition-colors hover:bg-[#0050e6] active:bg-[var(--blue-80)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue)] disabled:bg-[var(--surface)] disabled:text-[var(--ink-subtle)]"
        >
          로그인
        </button>
      </form>

      {/*
        "가맹 회원가입" 버튼을 지웠다. 옆의 회원가입과 같은 `/register`를
        가리키고 있었고, `POST /auth/join`은 role 인자를 받지 않는다 —
        뒤에 아무것도 없는 버튼이었다. 상점 계정은 지금 시드가 만든다.
      */}
      <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
        계정이 없다면{' '}
        <Link href="/register" className="text-[var(--blue)] hover:underline">
          회원가입
        </Link>
      </p>
    </main>
  );
}
