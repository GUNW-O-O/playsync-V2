'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FinishPreview, FullTournamentInfo } from '@playsync/contract';

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
  preview,
  completeTournament,
  chopTournament,
  abortTournament,
  fetchFinishPreview,
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
  /** 페이지가 그릴 때 받아 둔 마무리 미리보기. 조회에 실패했으면 null이다. */
  preview: FinishPreview | null;
  completeTournament: (tournamentId: string) => Promise<ActionResult>;
  chopTournament: (tournamentId: string) => Promise<ActionResult>;
  abortTournament: (tournamentId: string) => Promise<ActionResult>;
  fetchFinishPreview: (
    tournamentId: string,
  ) => Promise<{ preview: FinishPreview } | { error: string }>;
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
  /*
    확인 대화. **여는 순간 미리보기를 새로 받는다.**

    페이지가 그린 값은 이미 낡았을 수 있다 — 그 사이 핸드가 돌고 칩이
    움직인다. 셋 다 되돌릴 수 없는 조작이라, 사람이 확인하는 숫자는
    **누르기 직전의 것**이어야 한다. 실패하면 대화를 열지 않는다: 숫자
    없이 「그래도 진행」을 내주면 확인 대화가 하는 일이 없어진다.
  */
  const [confirming, setConfirming] = useState<'chop' | 'abort' | null>(null);
  const [live, setLive] = useState<FinishPreview | null>(preview);

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
  /**
   * 확인 대화를 연다. 미리보기를 먼저 받고, 받은 뒤에만 연다.
   */
  function openConfirm(kind: 'chop' | 'abort') {
    startTransition(async () => {
      try {
        const result = await fetchFinishPreview(tournamentId);
        if ('error' in result) {
          setMessage(result.error);
          return;
        }
        setMessage(null);
        setLive(result.preview);
        setConfirming(kind);
      } catch {
        setMessage(NETWORK_ERROR);
      }
    });
  }

  /**
   * 마무리 조작. 성공하면 **그 자리에서 다시 그린다.**
   *
   * 처음에는 대회 목록으로 보냈는데, 콘솔에 그 화면이 없어서
   * (`(console)` 아래 라우트는 대회 상세 하나뿐이다) 404로 갔다. 게다가
   * `run`이 뒤이어 부르는 `router.refresh()`가 그 이동을 되돌려, 닫힌
   * 대회를 「진행 중」이라고 그린 낡은 화면이 남았다.
   *
   * 다시 그리면 대회가 `FINISHED`·`CANCELLED`로 오므로 마무리 영역이
   * 스스로 사라진다 — 조작이 없어졌다는 사실을 화면이 상태로 말한다.
   */
  function finish(action: () => Promise<ActionResult>) {
    setConfirming(null);
    run(action);
  }

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
          {/* 분모가 엔트리다(T81). 사람 수는 부제로 내린다 — 전광판과 같은 규칙. */}
          <Stat
            label="엔트리"
            value={numbers ? numbers.entryCount : '-'}
            sub={numbers ? `참가 ${numbers.totalPlayer}명` : undefined}
          />
          <Stat
            label="프라이즈풀"
            value={numbers ? numbers.prizePool.toLocaleString() : '-'}
          />
          {/*
            **상점 몫은 콘솔에만 있다.** 참가자 화면에 그리면 "내 참가비의
            일부가 어디로 갔나"가 프라이즈풀 옆에 상시로 붙는데, 그것은 대회
            안내문의 몫이지 전광판의 몫이 아니다.

            레이크가 0인 대회에는 줄이 없다 — 0원짜리 칸은 「가져갔다」와
            「가져갈 것이 없었다」를 같은 모양으로 만든다.
          */}
          {live && live.rakePercent > 0 && (
            <Stat
              label={`상점 몫 · ${live.rakePercent}%`}
              value={live.rakeAmount.toLocaleString()}
              small
            />
          )}
          {live && <Stat label="나간 상금" value={live.paidPrize.toLocaleString()} small />}
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

        {/*
          **마무리는 버튼 셋이 아니다.** 종료·ICM·중단은 규칙이 서로 다르고
          셋 다 되돌릴 수 없다 — 누르면 테이블과 딜러 세션과 Redis가 지워지고
          누가 몇 등이었는지 재구성할 근거가 남지 않는다. 같은 크기로 늘어
          놓으면 무엇이 일어날지 모른 채 가까운 것을 누른다. **줄 하나에 조작
          하나**, 왼쪽이 무엇을 하는지다.

          시작 전 대회에는 이 영역이 없다. 닫을 것이 아직 없고, 그때의
          되돌리기는 「취소」라는 다른 문이다.
        */}
        {live && tournament.status === 'ONGOING' && (
          <>
            <div className="h-px bg-[var(--hairline)]" />
            <div>
              <p className="mb-2.5 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">
                대회 마무리 — 되돌릴 수 없습니다
              </p>
              <div className="flex flex-col border border-[var(--hairline)]">
                <FinishRow
                  title="종료"
                  what="상금이 다 나간 뒤에 대회를 닫고 상점 몫을 정산합니다."
                  gate={live.complete}
                  pending={pending}
                  label="종료"
                  tone="primary"
                  onRun={() => finish(() => completeTournament(tournamentId))}
                />
                <FinishRow
                  title="ICM 마무리"
                  /*
                    문이 닫혀 있으면 명단이 비어 있다(`getFinishPreview`) —
                    그 값을 그대로 쓰면 「남은 0명이 나눕니다」가 된다.
                    인원은 나눌 수 있을 때만 말한다.
                  */
                  what={
                    live.chop.rows.length > 0
                      ? `남은 ${live.chop.rows.length}명이 남은 상금을 칩 비율대로 나누고 대회를 닫습니다.`
                      : '남은 사람이 남은 상금을 칩 비율대로 나누고 대회를 닫습니다.'
                  }
                  gate={live.chop}
                  pending={pending}
                  label="ICM 마무리"
                  tone="secondary"
                  onRun={() => openConfirm('chop')}
                />
                <FinishRow
                  title="중단"
                  what="대회를 열 수 없게 됐을 때. 진행 중인 사람은 낸 돈 전부, 탈락한 사람은 절반을 돌려받습니다."
                  gate={live.abort}
                  pending={pending}
                  label="중단"
                  tone="ghost"
                  onRun={() => openConfirm('abort')}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {confirming === 'chop' && live && (
        <ChopConfirm
          preview={live}
          pending={pending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => finish(() => chopTournament(tournamentId))}
        />
      )}
      {confirming === 'abort' && live && (
        <AbortConfirm
          preview={live}
          pending={pending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => finish(() => abortTournament(tournamentId))}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  small,
  sub,
}: {
  label: string;
  value: string | number;
  small?: boolean;
  sub?: string;
}) {
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
      {sub && <span className="text-[12px] text-[var(--ink-subtle)]">{sub}</span>}
    </div>
  );
}

/**
 * 마무리 조작 한 줄.
 *
 * **못 누르는 버튼을 숨기지 않는다.** 왜 못 누르는지를 그 자리에 적는다 —
 * 사라진 버튼은 "이 대회는 원래 종료가 없다"로 읽힌다. 그 문장은 서버가
 * 실제로 거절할 때 던지는 것과 같다(`FINISH_BLOCKERS`·`completeBlocker`).
 */
function FinishRow({
  title,
  what,
  gate,
  pending,
  label,
  tone,
  onRun,
}: {
  title: string;
  what: string;
  gate: { canRun: boolean; reason: string | null };
  pending: boolean;
  label: string;
  tone: 'primary' | 'secondary' | 'ghost';
  onRun: () => void;
}) {
  const button =
    tone === 'primary'
      ? 'bg-[var(--blue)] text-white'
      : tone === 'secondary'
        ? 'bg-[var(--ink)] text-white'
        : 'border border-[var(--err)] text-[var(--err)]';

  return (
    <div
      className={
        gate.canRun
          ? 'flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] p-4 last:border-b-0'
          : 'flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--surface)] p-4 last:border-b-0'
      }
    >
      <div className="flex flex-col gap-0.5">
        <b className="text-sm font-semibold">{title}</b>
        <span className="text-[13px] text-[var(--ink-subtle)]">{what}</span>
        {!gate.canRun && gate.reason && (
          <span className="text-[13px] text-[var(--err)]">{gate.reason}</span>
        )}
      </div>
      <button
        type="button"
        disabled={pending || !gate.canRun}
        onClick={onRun}
        className={`px-4 py-3 text-sm disabled:opacity-40 ${button}`}
      >
        {label}
      </button>
    </div>
  );
}

/**
 * 확인 대화의 껍데기.
 *
 * 대화 밖을 눌러 닫는 길은 두지 않는다 — 되돌릴 수 없는 조작 앞이라,
 * 실수로 닫히는 것보다 「취소」를 한 번 더 누르는 편이 낫다.
 */
function Modal({
  title,
  lede,
  children,
  foot,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
  foot: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-full w-full max-w-[520px] overflow-auto border border-[var(--hairline)] bg-[var(--canvas)] text-[var(--ink)]"
      >
        <div className="border-b border-[var(--hairline)] p-5">
          <h3 className="m-0 text-[19px] font-normal">{title}</h3>
          <p className="mb-0 mt-1.5 text-[13px] text-[var(--ink-subtle)]">{lede}</p>
        </div>
        <div className="p-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-[var(--hairline)] p-4">{foot}</div>
      </div>
    </div>
  );
}

function Ledger({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={h}
              className={
                i === 0
                  ? 'border-b border-[var(--hairline)] pb-2 text-left text-[11px] font-normal tracking-[0.06em] text-[var(--ink-subtle)]'
                  : 'border-b border-[var(--hairline)] pb-2 text-right text-[11px] font-normal tracking-[0.06em] text-[var(--ink-subtle)]'
              }
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** 오른쪽 정렬 숫자 칸. 표의 숫자는 자릿수가 맞아야 비교가 된다. */
const NUM = 'py-2 text-right font-mono tabular-nums';
const NAME = 'py-2 text-left';
const NOTE = 'ml-1.5 text-[12px] text-[var(--ink-subtle)]';

/**
 * ICM 마무리 확인.
 *
 * **딜은 사람이 합의한 결과를 시스템에 적는 일이다.** 화면의 숫자가 테이블
 * 위에서 합의한 숫자와 같은지 확인할 자리가 있어야 한다 — 그래서 누구에게
 * 얼마가 가는지를 먼저 보여주고, 합이 남은 상금과 같은지를 마지막 줄에 둔다.
 */
function ChopConfirm({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  preview: FinishPreview;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const stackSum = preview.chop.rows.reduce((sum, r) => sum + r.currentStack, 0);
  const amountSum = preview.chop.rows.reduce((sum, r) => sum + r.amount, 0);

  return (
    <Modal
      title="ICM으로 마무리할까요?"
      lede={`남은 상금 ${preview.remainingPrize.toLocaleString()}원을 지금 칩 비율대로 나눕니다. 대회는 그대로 닫힙니다.`}
      foot={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)]"
          >
            취소
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="bg-[var(--ink)] px-4 py-3 text-sm text-white disabled:opacity-40"
          >
            ICM 마무리
          </button>
        </>
      }
    >
      <Ledger head={['받는 사람', '칩', '상금']}>
        {preview.chop.rows.map((row) => (
          <tr key={row.userId} className="border-b border-[var(--hairline)]">
            <td className={NAME}>
              {row.nickname ?? row.userId}
              <span className={NOTE}>{row.place}위</span>
            </td>
            <td className={NUM}>{row.currentStack.toLocaleString()}</td>
            <td className={NUM}>{row.amount.toLocaleString()}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td className={NAME}>합계</td>
          <td className={NUM}>{stackSum.toLocaleString()}</td>
          <td className={NUM}>{amountSum.toLocaleString()}</td>
        </tr>
      </Ledger>
      <p className="mt-3.5 border-l-2 border-[var(--hairline)] pl-3 text-[13px] text-[var(--ink-subtle)]">
        등수는 칩이 정합니다.{' '}
        <strong className="text-[var(--ink)]">
          이미 나간 상금 {preview.paidPrize.toLocaleString()}원은 다시 나누지 않습니다.
        </strong>
      </p>
    </Modal>
  );
}

const ABORT_GROUP_LABEL: Record<string, { name: string; note: string }> = {
  LIVE: { name: '진행 중', note: '낸 돈 100%' },
  FINISHED: { name: '탈락', note: '낸 돈 50%' },
  PRIZED: { name: '상금 받은 사람', note: '받은 상금을 뺀 나머지' },
};

/**
 * 중단 확인.
 *
 * **마지막 줄이 걷은 돈이다.** 위 네 줄의 합과 같아야 하고, 그것이 서버가
 * 지키는 보존 등식이다 — 확인하는 사람이 그 등식을 눈으로 맞춰 볼 수 있어야
 * 「돌려줄 돈이 어디로 갔나」를 나중에 묻지 않는다.
 *
 * **0원 줄도 적는다.** 상금을 이미 받은 사람은 대개 0원인데, 그 줄을 지우면
 * 빠뜨린 것처럼 보인다 — 0이라는 것이 결과다.
 */
function AbortConfirm({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  preview: FinishPreview;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="대회를 중단할까요?"
      lede="진행 중인 사람은 낸 돈 전부, 이미 탈락한 사람은 절반을 돌려받습니다. 되돌릴 수 없습니다."
      foot={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="border border-[var(--hairline)] px-4 py-3 text-sm text-[var(--ink-subtle)]"
          >
            취소
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="bg-[var(--err)] px-4 py-3 text-sm text-white disabled:opacity-40"
          >
            중단
          </button>
        </>
      }
    >
      <Ledger head={['돌려주는 곳', '인원', '금액']}>
        {preview.abort.groups.map((group) => {
          const label = ABORT_GROUP_LABEL[group.kind];
          return (
            <tr key={group.kind} className="border-b border-[var(--hairline)]">
              <td className={NAME}>
                {label.name}
                <span className={NOTE}>{label.note}</span>
              </td>
              <td className={NUM}>{group.count}</td>
              <td className={NUM}>{group.amount.toLocaleString()}</td>
            </tr>
          );
        })}
        {/*
          **이미 나간 상금이 한 줄로 서야 합이 맞는다.**

          환불 세 줄과 상점 몫만 적으면 그 합이 걷은 돈보다 이미 지급된
          상금만큼 적다 — 실제로 그렇게 그려 놓고 보니 350,000에 287,000이
          붙어 있었다. 확인 대화의 존재 이유가 「합이 맞는가」인데 그 자리에서
          합이 안 맞으면, 보는 사람은 돈이 사라졌다고 읽는다.

          위의 「상금 받은 사람」과 다른 줄이다: 저쪽은 그 사람이 **환불로**
          받을 몫(대개 0)이고, 이 줄은 대회가 도는 동안 **이미 나간** 상금이다.
        */}
        {preview.paidPrize > 0 && (
          <tr className="border-b border-[var(--hairline)]">
            <td className={NAME}>
              이미 나간 상금<span className={NOTE}>대회 중에 지급됨</span>
            </td>
            <td className={NUM}>—</td>
            <td className={NUM}>{preview.paidPrize.toLocaleString()}</td>
          </tr>
        )}
        <tr className="border-b border-[var(--hairline)]">
          <td className={NAME}>
            상점<span className={NOTE}>나가고 남은 돈</span>
          </td>
          <td className={NUM}>—</td>
          <td className={NUM}>{preview.abort.storeAmount.toLocaleString()}</td>
        </tr>
        <tr className="font-semibold">
          <td className={NAME}>걷은 돈</td>
          <td className={NUM}>—</td>
          <td className={NUM}>{preview.totalBuyinAmount.toLocaleString()}</td>
        </tr>
      </Ledger>
      <p className="mt-3.5 border-l-2 border-[var(--hairline)] pl-3 text-[13px] text-[var(--ink-subtle)]">
        중단에는{' '}
        <strong className="text-[var(--ink)]">상점 몫을 따로 떼지 않습니다.</strong> 나가고 남은
        돈이 이미 상점 것입니다.
      </p>
      {/*
        **깎였다는 사실은 숨기지 않는다.** 상금이 크게 나간 뒤에 중단하면
        남은 돈이 환불 희망액보다 적어 비율대로 깎인다 — 운영이 그것을 모르면
        참가자에게 "낸 돈 전부"라고 말하게 된다.
      */}
      {preview.abort.scaled && (
        <p className="mt-2 text-[13px] text-[var(--err)]">
          남은 돈이 모자라 환불이 비율대로 깎였습니다. 위 금액이 실제로 나갑니다.
        </p>
      )}
    </Modal>
  );
}
