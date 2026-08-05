'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FullTournamentInfo } from '@playsync/contract';

/**
 * 대회 메타. `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }`
 * 봉투(`payment.service.ts:64`)의 `tournament` 쪽에서 이 화면이 쓰는 것만
 * 추린다 — `SessionService.getGameSession`이 실제로는 더 많은 필드를 준다.
 */
export type TournamentMeta = {
  id: string;
  name: string;
  status: string;
  isRegistrationOpen: boolean;
  rebuyUntil: number;
  entryFee: number;
  startStack: number;
};

export type TableInfo = { id: string; tableOrder: number };

/** `GET /store/sessions/:id/seats`(이 태스크가 만든 조회)의 응답 모양. */
export type SeatOccupant = { seatIndex: number; userId: string; nickname: string | null };
export type TableSeatInfo = { tableId: string; tableOrder: number; players: SeatOccupant[] };

type ActionResult = { ok: true } | { error: string };

/**
 * 좌석 도식의 자리 좌표. 와이어프레임
 * (`frontend/wireframes/2026-08-02-screens.html`) 450–458행의 실측 좌표를
 * 그대로 옮긴다 — 값을 새로 정하지 않는다. 배열 인덱스가 곧 `seatIndex`
 * (0-based)고, 화면에는 인덱스+1을 표시한다(같은 파일 517–518행: 화면은
 * 1~9, API는 seatIndex 0~8).
 */
const SEAT_POSITIONS: { left: string; top: string }[] = [
  { left: '73%', top: '15%' },
  { left: '92%', top: '35%' },
  { left: '94%', top: '60%' },
  { left: '78%', top: '82%' },
  { left: '50%', top: '90%' },
  { left: '22%', top: '82%' },
  { left: '6%', top: '60%' },
  { left: '8%', top: '35%' },
  { left: '27%', top: '15%' },
];

const STATUS_LABEL: Record<string, string> = {
  PENDING: '시작 전',
  ONGOING: '진행 중',
  FINISHED: '종료',
};

/**
 * 상점 콘솔의 대회 상세. 이 면은 Carbon 그대로다 — `--canvas` `--surface`
 * `--ink` `--ink-subtle` `--hairline` `--blue` 토큰만 쓰고 태블릿 토큰
 * (`--tb-*`)은 쓰지 않는다.
 *
 * 조작 다섯(대회 시작·테이블 열기/닫기·좌석 해제·딜러 OTP 재발급) 모두
 * 서버 액션으로 위임한다. 서버가 돌려준 실패 문구를 그대로 배너에 띄울 뿐,
 * 역할에 따라 버튼을 숨기는 분기는 만들지 않는다 — 권한의 진실은 백엔드
 * 한 곳이다(브리프·보고서 참고).
 */
export default function ConsoleClient({
  storeId,
  tournamentId,
  tournament,
  dashboard,
  tables,
  seatOccupants,
  seatError,
  startTournament,
  openTable,
  closeTable,
  releaseSeats,
  reissueDealerOtp,
}: {
  storeId: string;
  tournamentId: string;
  tournament: TournamentMeta | null;
  dashboard: FullTournamentInfo | null;
  tables: TableInfo[];
  seatOccupants: TableSeatInfo[];
  seatError: string | null;
  startTournament: (tournamentId: string) => Promise<ActionResult>;
  openTable: (tournamentId: string) => Promise<ActionResult>;
  closeTable: (tournamentId: string, tableId: string) => Promise<ActionResult>;
  releaseSeats: (
    tournamentId: string,
    tableId: string,
    seats: { seatIndex: number; userId: string }[],
  ) => Promise<ActionResult>;
  reissueDealerOtp: (
    tournamentId: string,
  ) => Promise<{ ok: true; dealerOtp: string } | { error: string }>;
}) {
  const router = useRouter();
  const [activeTableId, setActiveTableId] = useState<string | null>(tables[0]?.id ?? null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(seatError);
  // 재발급 이전에는 평문 OTP를 아는 곳이 없다 — 생성 시점의 평문은 이
  // 화면과 다른 요청·다른 순간에 이미 지나갔다(session.service.ts의
  // createSession 주석). 그래서 초기값은 항상 비어 있다.
  const [dealerOtp, setDealerOtp] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const activeTable = tables.find((t) => t.id === activeTableId) ?? tables[0] ?? null;
  const occupants = seatOccupants.find((t) => t.tableId === activeTable?.id)?.players ?? [];
  const occupantBySeat = new Map(occupants.map((p) => [p.seatIndex, p]));
  const selectedSeats = [...selected]
    .map((i) => occupantBySeat.get(i))
    .filter((p): p is SeatOccupant => p !== undefined);

  function toggleSeat(seatIndex: number) {
    if (!occupantBySeat.has(seatIndex)) return; // 빈 자리는 뗄 사람이 없다.
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seatIndex)) next.delete(seatIndex);
      else next.add(seatIndex);
      return next;
    });
  }

  function selectTable(id: string) {
    setActiveTableId(id);
    setSelected(new Set());
  }

  /**
   * 조작 성공 뒤 화면을 새로 고친다. `router.refresh()`는 서버 컴포넌트
   * (`page.tsx`)의 네 조회를 다시 돌려 이 컴포넌트를 최신 props로
   * 다시 그린다 — 조작마다 각자 낙관적으로 상태를 흉내 내지 않는다.
   */
  function run(action: () => Promise<ActionResult>, onSuccess?: () => void) {
    startTransition(async () => {
      const result = await action();
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      setMessage(null);
      onSuccess?.();
      router.refresh();
    });
  }

  function handleReissue() {
    startTransition(async () => {
      const result = await reissueDealerOtp(tournamentId);
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      setMessage(null);
      setDealerOtp(result.dealerOtp);
    });
  }

  if (!tournament) {
    return <div className="p-8 text-[var(--ink)]">대회를 찾을 수 없습니다.</div>;
  }

  const numbers = dashboard?.dashboard ?? null;
  const displayUrl = `/stores/${storeId}/tournaments/${tournamentId}/display`;

  return (
    <div className="bg-[var(--canvas)] text-[var(--ink)]" style={{ letterSpacing: '0.16px' }}>
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">대회</p>
            <div className="text-[30px] font-light leading-[1.15]">{tournament.name}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(36,161,72,0.12)] px-2.5 py-1 text-[var(--ok)]">
                {STATUS_LABEL[tournament.status] ?? tournament.status}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] px-2.5 py-1 text-[var(--ink-subtle)]">
                {tournament.isRegistrationOpen ? '등록 열림' : '등록 마감'}
              </span>
              <span className="text-[13px] text-[var(--ink-subtle)]">
                레벨 {tournament.rebuyUntil}까지 리바인
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            {tournament.status === 'PENDING' && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => startTournament(tournamentId))}
                className="rounded bg-[var(--blue)] px-4 py-3 text-sm text-white disabled:opacity-40"
              >
                대회 시작
              </button>
            )}
            <a
              href={displayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)]"
            >
              전광판 열기
            </a>
          </div>
        </div>

        {message && (
          <p role="alert" className="text-sm text-[var(--err)]">
            {message}
          </p>
        )}

        <div className="h-px bg-[var(--hairline)]" />

        <div className="flex flex-wrap gap-7">
          <Stat label="남은 인원" value={numbers ? numbers.activePlayer : '-'} />
          <Stat label="총 참가" value={numbers ? numbers.totalPlayer : '-'} />
          <Stat
            label="프라이즈풀"
            value={numbers ? numbers.prizePool.toLocaleString() : '-'}
          />
          <Stat label="참가비" value={tournament.entryFee.toLocaleString()} small />
          <Stat
            label="평균 스택"
            value={(numbers ? numbers.avgStack : tournament.startStack).toLocaleString()}
            small
          />
        </div>

        <div className="h-px bg-[var(--hairline)]" />

        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
            <div>
              <p className="mb-0.5 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">좌석</p>
              <span className="text-[13px] text-[var(--ink-subtle)]">
                옮길 사람의 자리를 고른다. 여러 명을 한 번에 뺄 수 있다.
              </span>
            </div>
            <div className="flex items-center gap-2">
              {tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`console-pick-table-${t.id}`}
                  onClick={() => selectTable(t.id)}
                  className={
                    t.id === activeTable?.id
                      ? 'rounded border border-[var(--blue)] px-2.5 py-1.5 text-xs text-[var(--blue)]'
                      : 'rounded border border-[var(--hairline)] px-2.5 py-1.5 text-xs text-[var(--ink-subtle)]'
                  }
                >
                  {t.tableOrder}번 테이블
                </button>
              ))}
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => openTable(tournamentId))}
                className="rounded border border-[var(--hairline)] px-2.5 py-1.5 text-xs text-[var(--ink-subtle)] disabled:opacity-40"
              >
                테이블 추가
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-stretch gap-5">
            <div className="min-w-[300px] grow">
              <div
                className="relative border border-[var(--hairline)] bg-[var(--surface)]"
                style={{ aspectRatio: '3 / 2' }}
              >
                <div
                  className="absolute rounded-[46%/58%] border border-[var(--ink-subtle)] bg-[var(--canvas)]"
                  style={{ inset: '16% 10%' }}
                />
                <div className="absolute left-1/2 top-[7%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-[var(--ink)] px-3 py-1 text-[10.5px] tracking-[0.06em] text-white">
                  딜러
                </div>
                {SEAT_POSITIONS.map((pos, seatIndex) => {
                  const occupant = occupantBySeat.get(seatIndex) ?? null;
                  const isSelected = selected.has(seatIndex);
                  return (
                    <button
                      key={seatIndex}
                      type="button"
                      data-testid={`console-seat-${seatIndex}`}
                      disabled={!occupant}
                      onClick={() => toggleSeat(seatIndex)}
                      className={
                        !occupant
                          ? 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border border-dashed border-[var(--hairline)] bg-transparent px-1.5 py-1 text-center text-[10.5px] leading-[1.3] text-[var(--ink-subtle)]'
                          : isSelected
                            ? 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border border-[var(--blue)] bg-[var(--canvas)] px-1.5 py-1 text-center text-[10.5px] leading-[1.3] shadow-[0_0_0_2px_rgba(15,98,254,0.22)]'
                            : 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border border-[var(--hairline)] bg-[var(--canvas)] px-1.5 py-1 text-center text-[10.5px] leading-[1.3]'
                      }
                      style={{ left: pos.left, top: pos.top }}
                    >
                      <span className="block font-mono text-[9.5px] text-[var(--ink-subtle)]">
                        {seatIndex + 1}
                      </span>
                      <span className="block truncate">{occupant?.nickname ?? '빈 자리'}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex w-[250px] flex-col gap-3">
              <div className="border border-[var(--hairline)] bg-[var(--surface)] p-4">
                <p className="mb-2 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">
                  고른 자리 {selectedSeats.length}
                </p>
                {selectedSeats.length === 0 ? (
                  <p className="text-[13px] text-[var(--ink-subtle)]">자리를 골라 주세요.</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {selectedSeats.map((p) => (
                      <li key={p.seatIndex} className="flex justify-between gap-2">
                        <span>
                          {p.seatIndex + 1}번 · {p.nickname ?? p.userId}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                disabled={pending || selectedSeats.length === 0}
                onClick={() =>
                  activeTable &&
                  run(
                    () =>
                      releaseSeats(
                        tournamentId,
                        activeTable.id,
                        selectedSeats.map((p) => ({ seatIndex: p.seatIndex, userId: p.userId })),
                      ),
                    () => setSelected(new Set()),
                  )
                }
                className="w-full rounded bg-[var(--blue)] py-3 text-sm text-white disabled:opacity-40"
              >
                고른 자리 해제
              </button>
              <p className="m-0 text-[13px] text-[var(--ink-subtle)]">
                해제해도 칩은 그대로다 — 자리만 잃는다. 안내받은 테이블로 걸어가서
                참가 OTP를 다시 넣으면 그 자리가 자기 자리가 된다.
              </p>
              <div className="h-px bg-[var(--hairline)]" />
              <button
                type="button"
                disabled={pending || !activeTable || occupants.length > 0}
                onClick={() => activeTable && run(() => closeTable(tournamentId, activeTable.id))}
                className="w-full rounded border border-[var(--hairline)] py-3 text-sm text-[var(--ink-subtle)] disabled:opacity-40"
              >
                테이블 닫기{occupants.length > 0 ? ` · ${occupants.length}명 남음` : ''}
              </button>
            </div>
          </div>
        </div>

        <div className="h-px bg-[var(--hairline)]" />

        <div className="border border-[var(--hairline)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <div>
              <p className="mb-1 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">딜러 OTP</p>
              <div className="font-mono text-[26px] tracking-[0.16em]">{dealerOtp ?? '••••••'}</div>
              <div className="mt-1 text-[13px] text-[var(--ink-subtle)]">
                해시로만 저장한다. 이 화면을 벗어나면 재발급만 가능하다.
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={handleReissue}
              className="rounded border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)] disabled:opacity-40"
            >
              재발급
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">{label}</span>
      <span
        className={
          small
            ? 'font-mono text-[19px] font-light tabular-nums'
            : 'font-mono text-[26px] font-light tabular-nums'
        }
      >
        {value}
      </span>
    </div>
  );
}
