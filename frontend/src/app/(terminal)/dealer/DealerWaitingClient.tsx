'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Keypad from '@/component/Keypad';
import { apiFetch } from '@/lib/api';

/** 백엔드 `DealerDto`(`backend/shared/dto/dealer.dto.ts`)의
 * `@Matches(/^[0-9]{6}$/)`와 같은 값. 참가 OTP(8자리, `table/WaitingClient.tsx`의
 * `OTP_LENGTH`)와 다르다 — 딜러 OTP와 참가 OTP는 서로 다른 발급 경로다. */
const OTP_LENGTH = 6;

type Tournament = { id: string; name: string; status: string };
type Table = { id: string; tableOrder: number };
type AuthenticateDealerResult = { ok: true } | { error: string };
type AuthenticateDealerFn = (input: {
  tournamentId: string;
  tableId: string;
  otp: string;
}) => Promise<AuthenticateDealerResult>;

/**
 * 딜러 대기 화면. 좌석 대기 화면(`table/WaitingClient.tsx`)의 배치를 그대로
 * 쓰되 누르는 대상만 자리에서 테이블로 바꾼다 — 딜러는 좌석 하나가 아니라
 * 테이블 전체를 맡는다. 와이어프레임에 그림이 없는 유일한 화면이라, 명세가
 * 안 그린 것을 명세가 그린 문법(대회 전환의 세대 카운터, OTP 키패드)으로
 * 메운다.
 *
 * 대회 전환의 out-of-order 응답 방지는 `WaitingClient.selectTournament`와
 * 같은 패턴이다 — 요청마다 세대 번호를 매기고, 응답이 왔을 때 그 세대가
 * "지금 가장 최근에 보낸 요청"이 아니면 버린다.
 */
export default function DealerWaitingClient({
  // 현재는 렌더링에 쓰지 않는다 — `WaitingClient`와 같은 이유(상점명 조회는
  // 범위 밖)로 인터페이스에만 남겨 둔다.
  storeId: _storeId,
  tournaments,
  tables: initialTables,
  authenticateDealer,
}: {
  storeId: string;
  tournaments: Tournament[];
  tables: Table[];
  authenticateDealer: AuthenticateDealerFn;
}) {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState(tournaments[0]?.id ?? '');
  const [tables, setTables] = useState(initialTables);
  const [tableId, setTableId] = useState(initialTables[0]?.id ?? '');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tournament = tournaments.find((t) => t.id === tournamentId) ?? null;
  const selectedTable = tables.find((t) => t.id === tableId) ?? null;

  const tournamentRequestRef = useRef(0);

  async function selectTournament(id: string) {
    if (id === tournamentId) return;
    setTournamentId(id);
    setTableId('');
    setError(null);

    const requestId = ++tournamentRequestRef.current;

    const session = await apiFetch(`/api/dealer/${id}`, { cache: 'no-store' }).then((r) =>
      r.ok ? r.json() : null,
    );

    // 그 사이 다른 대회를 또 골랐다면 이 응답은 낡았다 — 버린다.
    if (tournamentRequestRef.current !== requestId) return;

    const nextTables = session?.tables ?? [];
    setTables(nextTables);
    setTableId(nextTables[0]?.id ?? '');
  }

  function selectTable(id: string) {
    setTableId(id);
    setError(null);
  }

  function pushDigit(d: string) {
    setOtp((prev) => (prev.length >= OTP_LENGTH ? prev : prev + d));
  }

  function clearOtp() {
    setOtp('');
  }

  async function submit() {
    if (!tableId || !tournamentId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // 토큰은 서버 액션 안에서 httpOnly 쿠키로 들어가고 여기로 돌아오지 않는다.
      const result = await authenticateDealer({ tournamentId, tableId, otp });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      router.push(`/dealer/table/${tableId}`);
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
        <span className="text-sm text-tb-muted">플레이싱크 · 딜러</span>
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

          <div>
            <p className="text-xs tracking-[0.14em] text-tb-act">맡을 테이블</p>
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              {tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`pick-table-${t.id}`}
                  onClick={() => selectTable(t.id)}
                  className={
                    t.id === tableId
                      ? 'rounded border border-tb-act bg-tb-act py-5 text-center font-mono text-lg font-bold text-[#06201a]'
                      : 'rounded border border-tb-line bg-tb-panel py-5 text-center font-mono text-lg text-tb-ink'
                  }
                >
                  {t.tableOrder}번
                </button>
              ))}
            </div>
            {tables.length === 0 && (
              <p className="mt-3 text-xs text-tb-sub">이 대회에 테이블이 없습니다.</p>
            )}
          </div>

          <p className="text-xs text-tb-sub">
            눈앞의 테이블을 고른다. <strong className="text-tb-muted">딜러 OTP</strong>는 대회 운영자에게
            받는다.
          </p>
        </div>

        <div className="flex w-[270px] shrink-0 flex-col gap-2 border-l border-tb-line px-5 py-5">
          <p className="text-xs tracking-[0.14em] text-tb-act">딜러 OTP</p>
          <div
            data-testid="otp-display"
            className="rounded border border-tb-line bg-tb-panel px-3 py-2.5 text-center font-mono text-xl tracking-[0.2em] text-tb-ink"
          >
            {otp ? otp.replace(/./g, '●') : '⋅⋅⋅ ⋅⋅⋅'}
          </div>

          <Keypad onDigit={pushDigit} onClear={clearOtp} />

          <button
            type="button"
            onClick={submit}
            disabled={!tableId || otp.length === 0 || submitting}
            className="rounded border border-tb-act bg-tb-act py-2.5 text-sm font-bold text-[#06201a] disabled:opacity-40"
          >
            {selectedTable ? `${selectedTable.tableOrder}번 테이블 인증` : '인증'}
          </button>

          {error && (
            <p role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
