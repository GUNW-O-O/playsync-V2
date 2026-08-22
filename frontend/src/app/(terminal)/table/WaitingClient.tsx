'use client';

import { useEffect, useRef, useState } from 'react';
import Keypad from '@/component/Keypad';
import { apiFetch } from '@/lib/api';

/** 백엔드 `PLAYER_OTP_LENGTH`(`backend/src/payment/player-otp.ts`)와 같은 값.
 * contract 패키지에 없다 — 참가 OTP 발급은 백엔드 전용 흐름이라 프론트가
 * 공유할 이유가 없고, 여기서는 입력을 더 받지 않게 막고 **덜 채운 것을
 * 보내지 않게** 하는 용도다. */
const OTP_LENGTH = 8;

/** 좌석 현황을 다시 읽는 주기. */
const SEAT_POLL_INTERVAL_MS = 5000;

/**
 * 조회가 **던졌을 때**의 문구. 백엔드가 준 실패는 응답으로 오지만,
 * 프록시가 끊기면 `fetch` 자체가 거부된다 — 원인을 모르니 다시 해 보라는
 * 것 말고 할 말이 없다. `ConsoleClient`의 같은 이름 상수와 같은 문구다(T70).
 */
const NETWORK_ERROR = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

/**
 * 좌석 도식의 자리 좌표. 와이어프레임(`frontend/wireframes/2026-08-02-screens.html`)
 * 671–683행의 실측 좌표를 그대로 옮긴다 — `Felt`(게임 화면용 큰 펠트)의 좌표
 * 공식과 같은 배치지만, 이 도식은 대기 화면 전용의 작은 그림이라 별도로 둔다.
 * 배열 인덱스가 곧 좌석 인덱스(0-based)고, 화면에는 인덱스+1을 표시한다.
 */
const SEAT_POSITIONS: { left: string; top: string }[] = [
  { left: '71.6%', top: '10.3%' },
  { left: '92.0%', top: '31.7%' },
  { left: '94.6%', top: '60.9%' },
  { left: '78.3%', top: '85.5%' },
  { left: '50%', top: '95%' },
  { left: '21.7%', top: '85.5%' },
  { left: '5.4%', top: '60.9%' },
  { left: '8.0%', top: '31.7%' },
  { left: '28.4%', top: '10.3%' },
];

const EMPTY_SEAT_STATUS = Array(9).fill(false);

type Tournament = { id: string; name: string; status: string };
type Table = { id: string; tableOrder: number };
type SeatMapEntry = { tableId: string; seatStatus: boolean[] };
type EnterSeatResult = { ok: true; tableId: string } | { error: string };
type EnterSeatFn = (input: {
  tournamentId: string;
  tableId: string;
  seatIndex: number;
  otp: string;
}) => Promise<EnterSeatResult>;

export default function WaitingClient({
  // 현재는 렌더링에 쓰지 않는다 — 화면 상단에 상점명을 보여주려면 별도
  // 조회가 필요한데(이 화면이 아는 것은 storeId뿐, 이름은 없다) 범위 밖이다.
  // 인터페이스에는 남겨 둔다: `page.tsx`가 `?store=`를 그대로 넘기고,
  // 나중에 상점명 조회가 생기면 prop을 더 만들 필요 없이 여기서 쓰면 된다.
  storeId: _storeId,
  tournaments,
  tables: initialTables,
  seatMap: initialSeatMap,
  enterSeat,
}: {
  storeId: string;
  tournaments: Tournament[];
  tables: Table[];
  seatMap: SeatMapEntry[];
  enterSeat: EnterSeatFn;
}) {
  const [tournamentId, setTournamentId] = useState(tournaments[0]?.id ?? '');
  const [tables, setTables] = useState(initialTables);
  const [tableId, setTableId] = useState(initialTables[0]?.id ?? '');
  const [seatMap, setSeatMap] = useState(initialSeatMap);
  const [seatIndex, setSeatIndex] = useState<number | null>(null);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tournament = tournaments.find((t) => t.id === tournamentId) ?? null;

  // 대회를 빠르게 두 번 이상 고르면 두 요청이 동시에 떠 있을 수 있고,
  // 네트워크는 응답 순서를 보장하지 않는다 — 나중에 고른 대회의 응답이
  // 먼저 오고, 먼저 고른 대회(이미 버려진 선택)의 응답이 늦게 와서 화면을
  // 덮어쓸 수 있다. 요청마다 세대 번호를 매기고, 응답이 왔을 때 그 세대가
  // "지금 가장 최근에 보낸 요청"이 아니면 버린다(Important 1 리뷰).
  const tournamentRequestRef = useRef(0);

  // 상점에 진행 중인 대회가 여럿이면 화면에서 고를 수 있어야 한다
  // (와이어프레임 646–723행이 대회 이름을 상단에 보여준다). `page.tsx`는
  // 첫 번째 대회의 테이블·좌석만 미리 읽어 오므로, 다른 대회를 고르면
  // 그 대회의 테이블 목록과 좌석 현황을 여기서 새로 읽는다.
  async function selectTournament(id: string) {
    if (id === tournamentId) return;
    setTournamentId(id);
    setTableId('');
    setSeatIndex(null);
    setError(null);

    const requestId = ++tournamentRequestRef.current;

    // **던지는 것과 실패 응답은 다른 길이다.** 실패 응답은 위에서 `null`·`[]`로
    // 접어 두지만, 프록시가 끊기면 `fetch` 자체가 거부돼 이 함수가 던진다.
    // 잡지 않으면 처리되지 않은 프라미스 거부 하나만 남고, 화면은 **앞 대회의
    // 테이블 목록을 그대로 든 채** 아무 안내도 안 띄운다 — 앉을 사람이 없어진
    // 자리를 고르고 있는다(`ConsoleClient.run`과 같은 결함, T70).
    let session: { tables?: Table[] } | null;
    let nextSeatMap: SeatMapEntry[];
    try {
      [session, nextSeatMap] = await Promise.all([
        apiFetch(`/api/dealer/${id}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        apiFetch(`/api/tournaments/${id}/seats`, { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : [],
        ),
      ]);
    } catch {
      if (tournamentRequestRef.current === requestId) setError(NETWORK_ERROR);
      return;
    }

    // 그 사이 다른 대회를 또 골랐다면 이 응답은 낡았다 — 버린다.
    if (tournamentRequestRef.current !== requestId) return;

    const nextTables = session?.tables ?? [];
    setTables(nextTables);
    setTableId(nextTables[0]?.id ?? '');
    setSeatMap(nextSeatMap ?? []);
  }

  // 좌석 현황만 5초마다 다시 읽는다. WS로 하지 않은 이유는
  // `entry.service.ts`의 `getSeatMap` 주석에 있다 — 대기 중인 태블릿은 아직
  // 티켓을 받을 자격 증명(JWT)이 없다.
  //
  // 이 폴링도 `selectTournament`와 같은 out-of-order 위험이 있어 보이지만
  // (대회를 바꾼 직후 이전 대회의 폴링 응답이 도착하는 경우), effect의
  // `cancelled` 클로저가 이미 막는다 — `tournamentId`가 바뀌면 cleanup이
  // 이전 클로저의 `cancelled`를 `true`로 만들고, 그 클로저를 캡처한 `poll`이
  // 나중에 응답을 받아도 `setSeatMap`을 부르지 않는다. 이 효과 자체가
  // `AbortController` 없는 세대 관리라 별도 카운터가 필요 없다.
  useEffect(() => {
    if (!tournamentId) return;
    let cancelled = false;

    async function poll() {
      // 이 폴링은 화면에 안내를 띄우지 않는다 — **다음 주기에 낫는** 것이라
      // 5초마다 뜨는 배너가 오히려 방해다. 다만 잡기는 해야 한다:
      // `setInterval`이 부르는 async 함수라 거부를 받을 곳이 아무 데도
      // 없고, 네트워크가 튈 때마다 처리되지 않은 프라미스 거부가 샌다.
      try {
        const res = await apiFetch(`/api/tournaments/${tournamentId}/seats`, { cache: 'no-store' });
        if (!cancelled && res.ok) {
          setSeatMap(await res.json());
        }
      } catch {
        // 다음 주기가 다시 읽는다. 좌석 도식은 직전 값에 머문다.
      }
    }

    const timer = setInterval(poll, SEAT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tournamentId]);

  const seatStatus = seatMap.find((s) => s.tableId === tableId)?.seatStatus ?? EMPTY_SEAT_STATUS;
  const selectedTable = tables.find((t) => t.id === tableId) ?? null;

  function selectTable(id: string) {
    setTableId(id);
    setSeatIndex(null);
    setError(null);
  }

  function pickSeat(i: number) {
    if (seatStatus[i]) return;
    setSeatIndex(i);
    setError(null);
  }

  function pushDigit(d: string) {
    setOtp((prev) => (prev.length >= OTP_LENGTH ? prev : prev + d));
  }

  function clearOtp() {
    setOtp('');
  }

  async function submit() {
    // 길이까지 본다. `otp.length === 0`만 보던 때는 한 자리만 눌러도
    // 백엔드까지 왕복해 실패로 돌아왔다 — 태블릿에서 오타는 흔하다.
    if (otp.length !== OTP_LENGTH) return;
    if (seatIndex === null || !tableId || !tournamentId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await enterSeat({ tournamentId, tableId, seatIndex, otp });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      // 클라이언트 라우팅(`useRouter`)이 아니라 완전한 이동을 쓴다. 좌석
      // 확정은 이 기기가 지금부터 "그 좌석"이 되는 사건이라, 다음 화면
      // (`/table/[tableId]`)이 방금 심어진 `accessToken` 쿠키를 가지고
      // 처음부터 다시 렌더링되는 편이 낫다.
      window.location.href = `/table/${result.tableId}`;
    } finally {
      setSubmitting(false);
    }
  }

  if (tournaments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-tb-muted">
        진행 중인 대회가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-tb-line px-6 py-3">
        <span className="text-sm text-tb-muted">플레이싱크</span>
        <span className="text-xs text-tb-sub">전체화면 · 화면 꺼짐 방지</span>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex min-w-0 grow flex-col justify-center gap-4 px-6 py-5">
          <div>
            <p className="text-xs tracking-[0.14em] text-tb-act">진행 중</p>
            {tournaments.length > 1 && (
              <div className="mt-2 flex gap-2">
                {tournaments.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`pick-tournament-${t.id}`}
                    onClick={() => selectTournament(t.id)}
                    className={
                      t.id === tournamentId
                        ? 'rounded border border-tb-act bg-tb-act px-2 py-1 text-xs font-bold text-[#06201a]'
                        : 'rounded border border-tb-line px-2 py-1 text-xs text-tb-muted'
                    }
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-1 text-2xl font-light text-tb-ink">
              {tournament?.name ?? '대회 정보 없음'}
            </div>
          </div>

          <div className="border-t border-tb-line" />

          <div className="flex items-center justify-between">
            <p className="text-xs tracking-[0.14em] text-tb-act">앉을 자리</p>
            <div className="flex gap-1.5">
              {tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`pick-table-${t.id}`}
                  onClick={() => selectTable(t.id)}
                  className={
                    t.id === tableId
                      ? 'rounded border border-tb-act bg-tb-act px-2 py-1 text-xs font-bold text-[#06201a]'
                      : 'rounded border border-tb-line px-2 py-1 text-xs text-tb-muted'
                  }
                >
                  {t.tableOrder}번 테이블
                </button>
              ))}
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[330px]" style={{ aspectRatio: '5 / 3' }}>
            <div
              className="absolute rounded-[44%/56%] border-[3px] border-felt-rail bg-felt"
              style={{ inset: '14% 12%' }}
            />
            <div className="absolute left-1/2 top-[5%] -translate-x-1/2 whitespace-nowrap border border-[#4a3627] bg-felt-rail px-2.5 py-0.5 text-[9px] tracking-[0.14em] text-[#d8c3ae]">
              딜 러
            </div>
            {seatStatus.map((taken, i) => {
              // **도식에 자리가 있는 인덱스만 그린다.** 비트맵이 아홉보다 길게
              // 오면 예전에는 `SEAT_POSITIONS[i].left`에서 던져 대기 화면이
              // 통째로 죽었다 — 그 순간 그 태블릿은 참가 자체를 못 한다.
              // 좌석 수는 지금 어디서나 9지만 그 사실이 이 파일에 적혀 있지
              // 않아서, 늘어나는 날 죽는 대신 아홉만 그린다.
              const pos = SEAT_POSITIONS[i];
              if (!pos) return null;

              const isPicked = seatIndex === i;
              return (
                <button
                  key={i}
                  type="button"
                  data-testid={`pick-seat-${i}`}
                  // 접근성 이름을 숫자 하나로 두면 Keypad의 같은 숫자 버튼과
                  // 겹친다(`getByRole('button', { name: '1' })`가 둘을 다
                  // 찾는다). 자리 버튼은 별도 라벨을 준다.
                  aria-label={`${i + 1}번 자리`}
                  disabled={taken}
                  onClick={() => pickSeat(i)}
                  /*
                    여기서는 **고를 수 있는 자리가 튀어야** 한다 — 사람이 하는
                    일이 빈 의자를 누르는 것이기 때문이다(펠트와 반대다. 거기서는
                    앉은 사람이 정보다).
                    이전에는 셋 다 `--tb-line`(#2b3134) 1px이라 찬 자리와 빈 자리가
                    점선 여부로만 갈렸다.
                  */
                  className={
                    isPicked
                      ? 'absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center border-2 border-tb-act bg-tb-act font-mono text-sm font-bold text-[#06201a]'
                      : taken
                        ? 'absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center border-2 border-dashed border-[rgba(238,242,243,0.14)] bg-transparent font-mono text-sm text-tb-sub opacity-60'
                        : 'absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center border-2 border-tb-muted bg-tb-panel font-mono text-sm text-tb-ink'
                  }
                  style={{ left: pos.left, top: pos.top }}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          {/* "배치는 눈앞의 테이블 그대로다"를 지웠다. 설계 판단이고,
              앉은 사람은 고개만 들면 그 사실을 이미 본다. */}
          <p className="text-xs text-tb-sub">
            점선은 이미 앉은 자리입니다. <strong className="text-tb-muted">지금 앉은 의자</strong>를
            누르세요.
          </p>
        </div>

        <div className="flex w-[270px] shrink-0 flex-col gap-2 border-l border-tb-line px-5 py-5">
          <p className="text-xs tracking-[0.14em] text-tb-act">참가 OTP</p>
          <div
            data-testid="otp-display"
            className="rounded border border-tb-line bg-tb-panel px-3 py-2.5 text-center font-mono text-xl tracking-[0.2em] text-tb-ink"
          >
            {otp ? otp.replace(/./g, '●') : '⋅⋅⋅⋅ ⋅⋅⋅⋅'}
          </div>

          <Keypad onDigit={pushDigit} onClear={clearOtp} />

          <button
            type="button"
            onClick={submit}
            disabled={seatIndex === null || otp.length !== OTP_LENGTH || submitting}
            className="rounded border border-tb-act bg-tb-act py-2.5 text-sm font-bold text-[#06201a] disabled:opacity-40"
          >
            {selectedTable && seatIndex !== null
              ? `${selectedTable.tableOrder}번 테이블 ${seatIndex + 1}번 위치 참가`
              : '참가'}
          </button>

          {error && (
            <p role="alert" className="text-sm text-err">
              {error}
            </p>
          )}

          <p className="text-xs text-tb-sub">
            폰의 <strong className="text-tb-muted">내 참가</strong>에서 확인하세요.
          </p>
        </div>
      </div>
    </div>
  );
}
