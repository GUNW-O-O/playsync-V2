'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FullTournamentInfo } from '@playsync/contract';

/**
 * 대회 메타. `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }`
 * 봉투(`payment.service.ts`의 `getTournamentInfo`)의 `tournament` 쪽에서
 * 이 화면이 쓰는 것만 추린다 — 그 조회는 `tables`·`blindStructure`까지
 * select하므로 실제로는 더 많은 필드를 준다. `page.tsx`의 `toTournamentMeta`가
 * 이 타입에 맞춰 필드를 고른다.
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

/** 탭 안에서만 사는 저장 키. 대회마다 따로 둔다. */
function dealerOtpKey(tournamentId: string) {
  return `playsync:dealer-otp:${tournamentId}`;
}

/**
 * 서버 액션이 **던졌을 때**의 문구. 백엔드가 준 실패 문구는 서버 액션이
 * `{ error }`로 실어 오므로(`action.ts`의 `failureMessage`) 그것을 그대로
 * 띄우고, 여기 오는 것은 응답 자체가 없었던 경우다 — 원인을 모르니 다시
 * 해 보라는 것 말고 할 말이 없다.
 */
const NETWORK_ERROR = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

const STATUS_LABEL: Record<string, string> = {
  PENDING: '시작 전',
  ONGOING: '진행 중',
  FINISHED: '종료',
  CANCELLED: '취소',
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
  /*
    선택은 좌석 번호가 아니라 **체크한 순간의 사람**이다.

    이 화면은 조작마다 `router.refresh()`로 다시 그려지고(`run`), 그 사이 그
    자리 사람이 탈락하고 다른 사람이 참가 OTP로 앉을 수 있다 — T28이 핸드
    도중 착석을 허용해서 창이 항상 열려 있다. 좌석 번호만 들고 있다가 보낼
    때 지금의 `occupantBySeat`에서 `userId`를 다시 뽑으면 **체크한 적 없는
    사람이 떨어진다.**

    `ReleaseSeatItem`이 `seatIndex`와 함께 `userId`를 요구하는 이유가 정확히
    그 낡은 화면을 서버가 거절하게 하려는 것이다(`session.service.ts`의
    `releaseSeats` 검사 1·2). 체크한 순간의 `userId`를 그대로 들고 가야 주인이
    바뀐 자리가 409로 걸린다 — **거절이 사고가 아니라 설계다.**
  */
  const [selected, setSelected] = useState<Map<number, SeatOccupant>>(new Map());
  // 좌석 조회 실패(`seatError`)는 조작 결과(`message`)와 별개 슬롯이다.
  // `useState(seatError)`는 마운트 시점의 초깃값으로만 쓰이고, 이후
  // `router.refresh()`가 새 `seatError`를 내려도 리렌더는 이 state를 다시
  // 초기화하지 않는다 — 그래서 예전에는 조작 성공의 `setMessage(null)`이
  // 아직 유효한 좌석 조회 실패 배너를 지웠다. `seatError`는 상태로 옮기지
  // 않고 prop을 그대로 렌더한다.
  const [message, setMessage] = useState<string | null>(null);
  /*
    재발급 이전에는 평문 OTP를 아는 곳이 **서버에도** 없다 — 저장은 해시로만
    하고(`dealerOtpHash`), 생성 시점의 평문은 이 화면과 다른 요청·다른 순간에
    이미 지나갔다(`session.service.ts`의 `createSession` 주석).

    그래서 한 번 받은 값은 **이 탭 안에서는 들고 있는다.** 이 화면은 좌석을
    해제할 때마다 `router.refresh()`로 다시 그려지고 사람이 새로 고치기도
    하는데, 그때마다 `••••••`로 돌아가면 상점은 아직 쓰지도 않은 번호를 또
    재발급하게 되고, 그 순간 딜러가 받아 적은 번호가 무효가 된다.

    `sessionStorage`인 이유는 탭을 닫으면 사라지기 때문이다 — "화면을 벗어나면
    재발급해야 한다"는 원래 계약이 그대로 남는다. 서버에 평문을 남기는
    선택지는 애초에 없다.
  */
  const [dealerOtp, setDealerOtp] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(dealerOtpKey(tournamentId));
  });
  const [pending, startTransition] = useTransition();

  const activeTable = tables.find((t) => t.id === activeTableId) ?? tables[0] ?? null;
  const occupants = seatOccupants.find((t) => t.tableId === activeTable?.id)?.players ?? [];
  const occupantBySeat = new Map(occupants.map((p) => [p.seatIndex, p]));
  // 판을 다시 그려도 이 목록은 움직이지 않는다 — 체크한 순간에 담아 둔 것을
  // 그대로 꺼낸다(`selected` 주석).
  const selectedSeats = [...selected.values()];

  function toggleSeat(seatIndex: number) {
    const occupant = occupantBySeat.get(seatIndex);
    setSelected((prev) => {
      const next = new Map(prev);
      // 체크를 푸는 것은 지금 누가 앉아 있든 된다. 판이 바뀌어 자리가 비어도
      // 체크는 남으므로(그래야 서버가 거절한다) 푸는 길이 닫히면 상점은
      // 화면을 통째로 새로 고치기 전에는 그 체크를 못 뗀다.
      if (next.has(seatIndex)) {
        next.delete(seatIndex);
        return next;
      }
      if (!occupant) return prev; // 빈 자리는 새로 체크할 사람이 없다.
      next.set(seatIndex, occupant);
      return next;
    });
  }

  function selectTable(id: string) {
    setActiveTableId(id);
    setSelected(new Map());
  }

  /**
   * 조작 성공 뒤 화면을 새로 고친다. `router.refresh()`는 서버 컴포넌트
   * (`page.tsx`)의 네 조회를 다시 돌려 이 컴포넌트를 최신 props로
   * 다시 그린다 — 조작마다 각자 낙관적으로 상태를 흉내 내지 않는다.
   *
   * **던지는 것과 실패 응답은 다른 길이다.** 서버 액션들은 백엔드가 준
   * 실패를 `{ error }`로 돌려주지만(`action.ts`의 `failureMessage`),
   * 프록시가 끊기거나 네트워크가 튀면 `fetch` 자체가 거부돼 여기서 던진다.
   * 잡지 않으면 처리되지 않은 프라미스 거부 하나만 남고 화면에는 아무
   * 안내도 뜨지 않는다 — 상점은 눌렀는데 아무 일도 안 일어난 것으로 본다.
   */
  function run(action: () => Promise<ActionResult>, onSuccess?: () => void) {
    startTransition(async () => {
      try {
        const result = await action();
        if ('error' in result) {
          setMessage(result.error);
          return;
        }
        setMessage(null);
        onSuccess?.();
        router.refresh();
      } catch {
        setMessage(NETWORK_ERROR);
      }
    });
  }

  /**
   * `run`을 거치지 않는 유일한 조작이다 — 성공 결과에서 `dealerOtp`를 꺼내
   * 화면과 `sessionStorage`에 실어야 해서 `ActionResult`만 받는 `run`의
   * 모양에 안 맞는다. 그래서 **던졌을 때의 처리도 여기 따로 필요하다**
   * (`run`의 주석과 같은 이유). 한 파일에 같은 결함이 두 벌 있으면 한쪽만
   * 고쳐지는 날이 온다.
   */
  function handleReissue() {
    startTransition(async () => {
      try {
        const result = await reissueDealerOtp(tournamentId);
        if ('error' in result) {
          setMessage(result.error);
          return;
        }
        setMessage(null);
        setDealerOtp(result.dealerOtp);
        window.sessionStorage.setItem(dealerOtpKey(tournamentId), result.dealerOtp);
      } catch {
        setMessage(NETWORK_ERROR);
      }
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
              <span className="inline-flex items-center gap-1.5 bg-[rgba(36,161,72,0.12)] px-2.5 py-1 text-[var(--ok)]">
                {STATUS_LABEL[tournament.status] ?? tournament.status}
              </span>
              <span className="inline-flex items-center gap-1.5 bg-[var(--surface)] px-2.5 py-1 text-[var(--ink-subtle)]">
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
                className="bg-[var(--blue)] px-4 py-3 text-sm text-white disabled:opacity-40"
              >
                대회 시작
              </button>
            )}
            <a
              href={displayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)]"
            >
              전광판 열기
            </a>
          </div>
        </div>

        {seatError && (
          <p role="alert" className="text-sm text-[var(--err)]">
            {seatError}
          </p>
        )}

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
              {/* "자리를 고른다"를 뺐다. 오른쪽 패널의 "해제할 자리를
                  누르세요"가 이미 그 동작을 말한다. 여기 남길 것은 그것이
                  말하지 않는 사실 — 한 번에 여럿이 된다는 것 — 하나다. */}
              <span className="text-[13px] text-[var(--ink-subtle)]">
                여러 명을 한 번에 뺄 수 있습니다.
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
                      ? 'border border-[var(--blue)] px-2.5 py-1.5 text-xs text-[var(--blue)]'
                      : 'border border-[var(--hairline)] px-2.5 py-1.5 text-xs text-[var(--ink-subtle)]'
                  }
                >
                  {t.tableOrder}번 테이블
                </button>
              ))}
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => openTable(tournamentId))}
                className="border border-[var(--hairline)] px-2.5 py-1.5 text-xs text-[var(--ink-subtle)] disabled:opacity-40"
              >
                테이블 추가
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-stretch gap-5">
            {/*
              폭에 제한이 없으면 3:2 상자가 1440×900 창의 세로를 넘어가서
              펠트 아래쪽이 잘렸다. 좌석 도식은 자리 배치를 읽는 그림이라
              크다고 더 읽히지 않는다 — 머리글과 함께 한 화면에 들어오는
              것이 먼저다.

              그래서 한 번 더 줄였다(760 → 520). 이 화면에서 실제로 하는 일은
              **자리를 골라 해제하는 것**이고, 도식이 화면 절반을 먹으면 그
              조작 패널이 오른쪽 끝으로 밀려 둘을 같이 볼 수 없다.
            */}
            <div className="min-w-[280px] max-w-[520px] grow">
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
                      // 체크가 남아 있으면 자리가 비어도 눌린다 — 푸는 길이다
                      // (`toggleSeat`).
                      disabled={!occupant && !isSelected}
                      onClick={() => toggleSeat(seatIndex)}
                      /*
                        찬 자리와 빈 자리가 **둘 다 흰 바탕에 #e0e0e0 테두리**라
                        사실상 같은 그림이었다. 실선/점선 1px 차이뿐이었다.
                        사람이 앉은 자리는 Carbon의 강한 실선(#161616)과 회색
                        채움으로 판이 되게 하고, 빈 자리는 채움도 이름도 없이
                        번호만 남긴다.
                      */
                      className={
                        isSelected
                          ? 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border-2 border-[var(--blue)] bg-[var(--canvas)] px-1.5 py-1 text-center text-[10.5px] leading-[1.3] shadow-[0_0_0_3px_rgba(15,98,254,0.22)]'
                          : !occupant
                            ? 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border border-dashed border-[var(--hairline)] bg-transparent px-1.5 py-1 text-center text-[10.5px] leading-[1.3] text-[var(--ink-subtle)]'
                            : 'absolute w-[74px] -translate-x-1/2 -translate-y-1/2 border-2 border-[var(--hairline-strong)] bg-[var(--surface)] px-1.5 py-1 text-center text-[10.5px] font-semibold leading-[1.3] text-[var(--ink)]'
                      }
                      style={{ left: pos.left, top: pos.top }}
                    >
                      {occupant ? (
                        <>
                          <span className="block font-mono text-[9.5px] text-[var(--ink-subtle)]">
                            {seatIndex + 1}
                          </span>
                          <span className="block truncate">{occupant.nickname}</span>
                        </>
                      ) : (
                        <span className="block font-mono text-[11px]">{seatIndex + 1}</span>
                      )}
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
                  <p className="text-[13px] text-[var(--ink-subtle)]">해제할 자리를 누르세요.</p>
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
                    () => setSelected(new Map()),
                  )
                }
                className="w-full bg-[var(--blue)] py-3 text-sm text-white disabled:opacity-40"
              >
                고른 자리 해제
              </button>
              <p className="m-0 text-[13px] text-[var(--ink-subtle)]">
                칩은 그대로입니다. 새 자리에서 참가 OTP를 다시 넣습니다.
              </p>
              <div className="h-px bg-[var(--hairline)]" />
              <button
                type="button"
                disabled={pending || !activeTable || occupants.length > 0}
                onClick={() => activeTable && run(() => closeTable(tournamentId, activeTable.id))}
                className="w-full border border-[var(--hairline)] py-3 text-sm text-[var(--ink-subtle)] disabled:opacity-40"
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
              <div data-testid="dealer-otp" className="font-mono text-[26px] tracking-[0.16em]">
                {dealerOtp ?? '••••••'}
              </div>
              {/* "해시로만 저장한다"를 지웠다. 저장 방식은 이 화면을 쓰는
                  상점 운영자의 일이 아니고, 그가 알아야 하는 것은 **지금
                  적어 두지 않으면 재발급해야 한다**는 결과뿐이다. */}
              <div className="mt-1 text-[13px] text-[var(--ink-subtle)]">
                이 탭에서만 남습니다. 탭을 닫으면 재발급해야 합니다.
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={handleReissue}
              className="border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)] disabled:opacity-40"
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
