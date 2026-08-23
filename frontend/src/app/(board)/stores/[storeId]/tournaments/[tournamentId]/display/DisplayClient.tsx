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
// **1초다.** 이 화면은 초 단위 카운트다운을 그리고, 10m 밖에서 그것만 보고
// 있는 사람들이 있다. 3초로 두었더니 대회 시작이 최대 3초 늦게 뜨고 그 사이
// 흐른 시간이 한 번에 건너뛰어 보였다 — 시계가 초를 세는데 갱신이 3초면
// 화면이 스스로 어긋나는 셈이다.
//
// 부하는 대회당 초당 요청 하나다. 응답은 Redis에서 읽은 대회 메타 한 덩이고
// (`getTournamentDashboard`), 전광판은 대회마다 한 대다.
const POLL_MS = 1000;

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

  // 요청마다 세대 번호를 매긴다. 3초 간격 폴링이라 응답이 느리면 다음
  // poll()이 이미 시작된 뒤 늦게 도착할 수 있고, 네트워크는 순서를 보장하지
  // 않는다 — 그 느린 응답이 나중에 최신 값을 덮으면 전광판 레벨이 되돌아가고
  // clockOffsetRef가 과거로 튄다. `WaitingClient.tsx`의 tournamentRequestRef와
  // 같은 방식(가장 최근에 보낸 요청의 세대가 아니면 버린다).
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const requestId = ++requestIdRef.current;

      // 요청 자체가 거부되는 경우(네트워크 단절)를 감싼다. `setInterval`이
      // 부르는 async 함수라 이 거부를 받아 줄 곳이 아무 데도 없고, 잡지
      // 않으면 Wi-Fi가 흔들리는 동안 처리되지 않은 프라미스 거부가 주기마다
      // 쌓인다. 전광판은 하루 종일 켜 두는 화면이다.
      //
      // **화면에 안내를 띄우지 않는다.** 다음 주기가 낫게 하는 종류라,
      // 1초마다 뜨는 배너가 오히려 방해다 — 값이 못 오는 동안은 직전
      // 화면에 머문다(깨진 본문·파싱 실패와 같은 처리).
      let res: Response;
      try {
        res = await apiFetch(`/api/playsync/dashboard/${tournamentId}`);
      } catch {
        return;
      }
      if (cancelled || requestIdRef.current !== requestId || !res.ok) return;

      // Nest가 컨트롤러에서 null을 반환하면 response.send()가 본문을 비운
      // 200을 내보낸다 — res.json()은 그 자리에서 파싱 에러로 던진다. 그래서
      // 텍스트를 먼저 보고 빈 본문과 깨진 본문을 갈라낸다.
      let text: string;
      try {
        text = await res.text();
      } catch {
        return; // 본문을 읽는 도중 끊긴 것도 같은 사건이다.
      }
      if (cancelled || requestIdRef.current !== requestId) return;

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
          {/*
            **앤티는 금액이다.** 「앤티 있음」만으로는 딜러도 참가자도 매 핸드
            얼마가 나가는지 화면으로 못 본다 — 칩이 디지털이고 화면이 유일한
            장부다(T58).

            계산은 백엔드 한 곳이다(`deriveAnteAmount`). 여기서 `sb / 5`를
            다시 적으면 백엔드가 식을 바꿀 때 조용히 어긋난다.

            **없으면 줄이 없다.** 「앤티 없음」을 적지 않는다. `> 0`으로 재는
            것은 `{0 && ...}`가 화면에 `0`을 남기기 때문이다 — boolean이던
            시절에는 없던 함정이다.
          */}
          {(current?.ante ?? 0) > 0 && (
            <AnteLine testId="ante-current" amount={current!.ante} />
          )}
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
            {next.ante > 0 && <AnteLine testId="ante-next" amount={next.ante} dim />}
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 border-t border-[#1b1f22]">
        <div className="pt-[18px] pr-1">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">남은 인원</span>
          <div
            data-testid="active-player"
            className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums"
          >
            {dashboard.activePlayer}
          </div>
        </div>
        {/*
          **분모가 엔트리다.** 프라이즈풀도 상금권 인원도 바이인 횟수에서
          파생되므로(T81), 그 자리에 사람 수가 있으면 "왜 저만큼인가"가 안
          읽힌다. 사람 수는 부제로 내린다 — 리바인이 없으면 둘이 같고,
          있으면 갈린다. 두 이름을 같은 크기로 나란히 두지 않는 이유는
          어느 쪽이 분모인지가 흐려지기 때문이다.
        */}
        <div className="border-l border-[#1b1f22] pl-5 pt-[18px]">
          <span className="font-cond text-sm uppercase tracking-[0.18em] text-sb-dim">엔트리</span>
          <div
            data-testid="entry-count"
            className="font-cond text-[clamp(30px,5vw,54px)] font-bold tabular-nums"
          >
            {dashboard.entryCount}
          </div>
          <div className="font-cond text-[13px] tracking-[0.1em] text-sb-dim">
            참가 {dashboard.totalPlayer}명
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

      <PrizeStrip prizes={dashboard.prizes} provisional={dashboard.isRegistrationOpen} />
    </div>
  );
}

/**
 * 앤티 금액 한 줄.
 *
 * 흐리게 두지 않는다(`dim`은 다음 레벨 쪽만) — 매 핸드 실제로 나가는 돈이라
 * 블라인드와 같은 무게로 읽혀야 한다.
 */
function AnteLine({ testId, amount, dim }: { testId: string; amount: number; dim?: boolean }) {
  return (
    <span
      data-testid={testId}
      /*
        자간을 넓히지 않는다. 이 줄은 「앤티」라는 한글 두 글자로 시작하는데,
        전광판의 다른 라벨에 쓰는 0.1em을 그대로 주면 「앤 티」로 벌어져
        읽힌다 — 자간은 라틴 대문자 라벨을 위한 값이었다.
      */
      className={
        dim
          ? 'mt-2 font-cond text-[clamp(17px,2.3vw,27px)] font-bold tabular-nums text-sb-dim'
          : 'mt-2 font-cond text-[clamp(17px,2.3vw,27px)] font-bold tabular-nums text-sb-ink'
      }
    >
      앤티 {amount.toLocaleString()}
    </span>
  );
}

/**
 * 목록이 한 줄을 넘칠 때부터 흐른다. **넷까지는 안 흐른다** — 이유 없는
 * 움직임은 읽는 사람이 눈으로 따라가게 만든다.
 *
 * 넘침을 실측(`ResizeObserver`)하지 않고 개수로 가르는 이유는 이 화면이
 * 고정된 한 대의 전광판이기 때문이다. 측정으로 재면 폰트가 늦게 뜨는 첫
 * 프레임에 판정이 뒤집혀 목록이 한 번 덜컥거린다.
 */
const FLOW_THRESHOLD = 4;

function PrizeStrip({
  prizes,
  provisional,
}: {
  prizes: { place: number; amount: number }[];
  provisional: boolean;
}) {
  const flowing = prizes.length > FLOW_THRESHOLD;

  const row = (
    <div className="flex gap-9 pr-9">
      {prizes.map((prize) => (
        <div key={prize.place} className="flex shrink-0 items-baseline gap-2.5">
          <span className="font-cond text-[17px] tracking-[0.14em] text-sb-dim">
            {ordinal(prize.place)}
          </span>
          <span
            className={
              provisional
                ? 'font-cond text-[clamp(22px,3.2vw,34px)] font-bold tabular-nums text-sb-dim'
                : 'font-cond text-[clamp(22px,3.2vw,34px)] font-bold tabular-nums'
            }
          >
            {prize.amount.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div
      className={
        provisional
          ? 'mt-[22px] border-t border-[#1b1f22] border-l-2 border-l-sb-dim pl-4 pt-[18px]'
          : 'mt-[22px] border-t border-[#1b1f22] pt-[18px]'
      }
    >
      {/*
        **미정 표시는 밝기와 문구가 나눠 든다.** 밝기가 "아직 아니다"를,
        문구가 "왜"를 말한다. 배지를 따로 달면 같은 사실이 세 번 적힌다.

        등록이 열려 있는 동안 상금이 미정인 이유는 리바인이 프라이즈풀을
        키우고, 구간이 바뀌면 상금권 인원까지 늘기 때문이다(T81).
      */}
      {provisional && (
        <div className="mb-2 font-cond text-[13px] tracking-[0.14em] text-sb-dim">
          마감 전 · 예상
        </div>
      )}
      {flowing ? (
        <div data-testid="prize-flow" className="overflow-hidden">
          <div className="sb-flow">
            {row}
            {/* 이음매를 메우는 사본. 화면에만 있고 읽히지 않는다. */}
            <div aria-hidden="true">{row}</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-9">{row}</div>
      )}
    </div>
  );
}

/** 1ST · 2ND · 3RD · 그 뒤로는 TH. 전광판은 10m 밖에서 등수만 읽는다. */
function ordinal(place: number): string {
  if (place === 1) return '1ST';
  if (place === 2) return '2ND';
  if (place === 3) return '3RD';
  return `${place}TH`;
}
