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
    <div className="flex flex-col gap-3">
      {message && (
        /* 실패 문구는 백엔드 것을 그대로 쓴다. 거절 이유가 여럿이라
           (포인트 부족·등록 마감·중복 참가) 화면이 뭉뚱그리면 무엇을
           고쳐야 하는지가 사라진다. 왼쪽 2px 빨강은 Carbon의 인라인
           알림 표시다. */
        <p
          role="alert"
          className="border-l-2 border-[var(--err)] bg-[var(--surface)] px-4 py-3 text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink)]"
        >
          {message}
        </p>
      )}
      {/* Carbon button-primary — 모서리 0px, 파랑 단색. 폰의 주 동작이라
          터치 타깃을 48px보다 키운다. */}
      <button
        type="button"
        disabled={pending || disabled}
        onClick={join}
        className="h-14 w-full bg-[var(--blue)] px-4 text-[16px] tracking-[0.16px] text-white transition-colors hover:bg-[#0050e6] active:bg-[var(--blue-80)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue)] disabled:bg-[var(--surface)] disabled:text-[var(--ink-subtle)]"
      >
        {entryFee.toLocaleString()} 포인트로 참가
      </button>
      {/* 설명 문단을 지웠다. "좌석이 아니라 OTP를 받는다"는 설계 판단이지
          지금 이 버튼을 누르는 사람이 알아야 할 것이 아니다 — 누르고 나면
          `/me`에서 OTP를 그대로 보게 된다. */}
    </div>
  );
}
