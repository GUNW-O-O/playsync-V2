'use client';

import { useEffect, useRef, useState } from 'react';
import { FullTournamentInfoSchema, type FullTournamentInfo } from '@playsync/contract';
import { apiFetch } from '@/lib/api';

// 조회가 곧 블라인드 시계를 미는 일이다 — getFullTournamentInfo가 안에서
// checkAndSyncBlindLevel을 부른다(redis.service.ts:282,285). 서버에 별도
// 타이머를 두지 않는 이유는 상태를 미는 코드가 한 곳뿐이라야 레벨과 마감이
// 두 갈래로 자라지 않기 때문이다. **그래서 전광판은 대회 내내 틀어 둔다.**
//
// 갈라지는 구간이 휴식이다. 그때는 startPreFlop이 거부되므로 미는 것이 이
// 폴링뿐이다. 휴식 동안 폴링을 늘려 자면 레벨이 제때 오르지 않는다 —
// 간격을 상태에 따라 바꾸지 않는다.
const POLL_MS = 3000;

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function DisplayClient({ tournamentId }: { tournamentId: string }) {
  const [info, setInfo] = useState<FullTournamentInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // serverTime과 브라우저 시계의 차이. 브라우저 시계를 그대로 믿으면
  // 태블릿마다 다른 숫자가 뜬다 — 매 폴링마다 이 값을 다시 잰다.
  const clockOffsetRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const res = await apiFetch(`/api/playsync/dashboard/${tournamentId}`);
      if (cancelled || !res.ok) return;

      // Nest가 컨트롤러에서 null을 반환하면 response.send()가 본문을 비운
      // 200을 내보낸다 — res.json()은 그 자리에서 파싱 에러로 던진다. 그래서
      // 텍스트를 먼저 보고 빈 본문과 깨진 본문을 갈라낸다.
      const text = await res.text();
      if (cancelled) return;

      if (text.length === 0) {
        // 시작 전에는 Redis 스냅샷이 없어 없는 대회와 구별되지 않는다.
        // 에러로 그리지 않고 "대기 중"으로 그린다.
        setInfo(null);
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // 깨진 본문 — 빈 본문과는 다른 사건이다. 그 자리에 머문다.
        return;
      }

      const parsed = FullTournamentInfoSchema.safeParse(json);
      if (!parsed.success) return; // 파싱 실패 — 그 자리에 머문다.

      clockOffsetRef.current = parsed.data.blindField.serverTime - Date.now();
      setInfo(parsed.data);
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tournamentId]);

  // 화면 시계는 1초마다 깎는다. 위 폴링과는 별개다.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  if (!info) {
    return (
      <div className="flex h-screen items-center justify-center bg-sb-bg">
        <span className="font-cond text-4xl uppercase tracking-[0.3em] text-sb-dim">대기 중</span>
      </div>
    );
  }

  const { dashboard, blindField } = info;
  const remainingMs = blindField.nextLevelAt - (now + clockOffsetRef.current);
  const remaining = formatClock(remainingMs);

  if (blindField.isBreak) {
    const next = blindField.blindStructure[blindField.currentBlindLv + 1];
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-sb-bg px-8 text-center">
        <div className="font-cond text-[clamp(20px,3vw,30px)] uppercase tracking-[0.3em] text-sb-break">
          휴식
        </div>
        <div className="font-cond text-[clamp(70px,15vw,170px)] font-bold leading-[0.9] tabular-nums text-sb-break">
          {remaining}
        </div>
        {next && (
          <div className="mt-5 font-cond text-[clamp(17px,2.4vw,26px)] tracking-[0.14em] text-sb-dim">
            다음 · LEVEL {next.lv} · {next.sb.toLocaleString()} / {(next.sb * 2).toLocaleString()} · 등록 마감
          </div>
        )}
      </div>
    );
  }

  const current = blindField.blindStructure[blindField.currentBlindLv];
  const next = blindField.blindStructure[blindField.currentBlindLv + 1];

  return (
    <div className="h-screen overflow-hidden bg-sb-bg px-8 py-7 text-sb-ink">
      <div className="flex items-baseline justify-between border-b border-[#1b1f22] pb-4 font-cond text-[15px] uppercase tracking-[0.16em] text-sb-dim">
        <span>{dashboard.tournamentName}</span>
        <span>등록 마감 레벨 {dashboard.rebuyUntil}</span>
      </div>

      <div className="flex flex-wrap items-end gap-11 py-7">
        <div className="flex flex-col gap-1.5">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">
            Level {current?.lv} · 블라인드
          </span>
          <span className="font-cond text-[clamp(56px,12vw,140px)] font-bold leading-[0.86] tabular-nums">
            {current?.sb.toLocaleString()} / {((current?.sb ?? 0) * 2).toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">다음 레벨</span>
          <span className="font-cond text-[clamp(56px,12vw,140px)] font-bold leading-[0.86] tabular-nums text-sb-live">
            {remaining}
          </span>
        </div>
        {next && (
          <div className="flex flex-col gap-1.5 pb-1.5">
            <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">다음</span>
            <span className="font-cond text-[clamp(26px,4.4vw,48px)] font-bold tabular-nums text-sb-dim">
              {next.sb.toLocaleString()} / {(next.sb * 2).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 border-t border-[#1b1f22]">
        <div className="pt-[18px] pr-1">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">남은 인원</span>
          <div className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums">
            {dashboard.activePlayer}
          </div>
        </div>
        <div className="border-l border-[#1b1f22] pl-5 pt-[18px]">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">총 참가</span>
          <div className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums">
            {dashboard.totalPlayer}
          </div>
        </div>
        <div className="border-l border-[#1b1f22] pl-5 pt-[18px]">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">평균 스택</span>
          <div className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums">
            {dashboard.avgStack.toLocaleString()}
          </div>
        </div>
        <div className="border-l border-[#1b1f22] pl-5 pt-[18px]">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">프라이즈풀</span>
          <div className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums">
            {dashboard.prizePool.toLocaleString()}
          </div>
        </div>
      </div>

      <div className="mt-[22px] flex flex-wrap gap-9 border-t border-[#1b1f22] pt-[18px]">
        {dashboard.prizes.map((prize) => (
          <div key={prize.place} className="flex items-baseline gap-2.5">
            <span className="font-cond text-[17px] tracking-[0.14em] text-sb-dim">
              {prize.place === 1 ? '1ST' : prize.place === 2 ? '2ND' : prize.place === 3 ? '3RD' : `${prize.place}TH`}
            </span>
            <span className="font-cond text-[clamp(22px,3.2vw,34px)] font-bold tabular-nums">
              {prize.amount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
