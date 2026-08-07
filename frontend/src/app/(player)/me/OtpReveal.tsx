'use client';

import { useState } from 'react';

/**
 * 참가 OTP. 이 화면의 **단 하나의 일**이다.
 *
 * 닫아 두는 이유는 둘이다. 홀은 사람이 붙어 앉는 곳이라 6~8자리가 내내 떠
 * 있으면 옆자리에서 그대로 읽힌다. 그리고 이 값은 **자리에 앉은 뒤에야**
 * 쓸모가 생긴다 — 그때 한 번 여는 동작이 곧 "지금 이걸 쓴다"는 표시다.
 *
 * 서버는 여전히 값을 지우지 않는다(`user.service.ts` — 대회가 FINISHED일
 * 때만 null). 여기서 감추는 것은 화면일 뿐이라 몇 번이든 다시 연다.
 *
 * 자릿수를 상수로 박지 않는다. 백엔드가 만드는 길이를 그대로 칸으로
 * 나눈다 — 박아 두면 발급 규칙이 바뀌는 날 화면이 조용히 어긋난다.
 */
export default function OtpReveal({ otp }: { otp: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        /* Carbon button-primary — 사각 0px, 파랑 단색, 터치 타깃 48px. */
        className="h-12 w-full bg-[var(--blue)] text-[14px] tracking-[0.16px] text-white transition-colors hover:bg-[#0050e6] active:bg-[var(--blue-80)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue)]"
      >
        참가 OTP 조회
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        칸을 나눠 그리는 것이 이 화면의 서명이다. 태블릿 키패드가 한 자리씩
        받으므로, 폰이 **다음에 칠 모양 그대로** 값을 보여준다. 눈이 몇 번째
        자리인지 세지 않아도 된다.
      */}
      <div
        data-testid="player-otp"
        aria-label="참가 OTP"
        className="flex border border-[var(--hairline)] bg-[var(--surface)]"
      >
        {otp.split('').map((digit, i) => (
          <span
            key={i}
            className={`flex h-14 flex-1 items-center justify-center font-mono text-[26px] font-light text-[var(--ink)] ${
              i > 0 ? 'border-l border-[var(--hairline)]' : ''
            }`}
          >
            {digit}
          </span>
        ))}
      </div>

      {/* 한 줄만 남긴다. 이름이 OTP라 한 번 쓰고 버리는 값으로 읽히는데,
          실제로는 자리를 옮겨도 같은 번호다. 그 오해만 지운다. */}
      <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
        자리 태블릿에 입력하세요. 다시 볼 수 있습니다.
      </p>

      <button
        type="button"
        onClick={() => setOpen(false)}
        /* Carbon button-ghost — 배경 없음, 파랑 글자. */
        className="h-12 self-start px-4 text-[14px] tracking-[0.16px] text-[var(--blue)] transition-colors hover:bg-[var(--surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue)]"
      >
        숨기기
      </button>
    </div>
  );
}
