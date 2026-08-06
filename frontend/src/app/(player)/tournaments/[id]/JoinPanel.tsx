'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type JoinResult = { ok: true } | { error: string };

/**
 * 참가 버튼과 실패 배너.
 *
 * 서버 컴포넌트에 두지 않은 이유는 실패 문구다 — 백엔드가 거절하는 이유가
 * 여럿이고(포인트 부족·등록 마감·중복 참가) 그 문구를 그대로 띄우려면
 * 응답을 받은 뒤 다시 그려야 한다.
 *
 * 좌석은 여기서 고르지 않는다(T28). 돈만 내고, 걸어가서, 안내받은 자리에
 * 앉은 다음 참가 OTP를 넣는다.
 */
export default function JoinPanel({
  tournamentId,
  entryFee,
  disabled,
  joinTournament,
}: {
  tournamentId: string;
  entryFee: number;
  disabled?: boolean;
  joinTournament: (tournamentId: string) => Promise<JoinResult>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function join() {
    startTransition(async () => {
      const result = await joinTournament(tournamentId);
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      setMessage(null);
      // 결제 응답에는 OTP가 없다 — `joinSession`이 돌려주는 것은
      // `{ id, status }`뿐이다. OTP를 읽는 곳은 `/me` 하나다.
      router.push('/me');
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {message && (
        <p role="alert" className="text-sm text-[var(--err)]">
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={pending || disabled}
        onClick={join}
        className="w-full rounded bg-[var(--blue)] px-4 py-4 text-base text-white disabled:opacity-40"
      >
        {entryFee.toLocaleString()} 포인트로 참가
      </button>
      <p className="text-center text-[13px] text-[var(--ink-subtle)]">
        참가하면 좌석 번호가 아니라 참가 OTP를 받는다
      </p>
    </div>
  );
}
