import Link from 'next/link';
import {
  ClosedTournamentStatusSchema,
  type ClosedTournamentStatus,
  type TournamentStatus,
} from '@playsync/contract';
import JoinPanel from './JoinPanel';
import { joinTournament } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/** `BlindStructure.structure`의 원소. `bb`는 없다 — `sb * 2`로 파생한다. */
type BlindLevel = { lv: number; sb: number; ante: boolean; duration: number };

/**
 * `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }` 봉투
 * (`PaymentService.getTournamentInfo`)의 `tournament` 쪽. 그 함수는
 * `SessionService.getGameSession`을 재사용하지 않고 자체 `select`를 쓰므로
 * 필드가 이보다 많고, 화면이 쓰는 것만 추린다. `dealerOtpHash`는 그
 * `select`가 이미 빼서 아예 나오지 않는다.
 */
type TournamentDetail = {
  id: string;
  name: string;
  status: TournamentStatus;
  // 컬럼이 아니라 파생값이다(T90). `getTournamentInfo`는 컬럼이 열려 있으면
  // `isRegistrationOpenLive`(registration-gate.ts)로 다시 판정해 그 결과로
  // 덮어써 내보낸다 — 컬럼은 상점이 손으로 닫은 것만 담고, 블라인드가
  // `rebuyUntil`을 지나 자동으로 닫힌 마감은 안 담아서 원시 컬럼을 그대로
  // 믿으면 마감된 대회에도 「등록 열림」이 뜬다.
  isRegistrationOpen: boolean;
  entryFee: number;
  startStack: number;
  rebuyUntil: number;
  totalPlayers: number;
  activePlayers: number;
  storeId: string;
  blindStructure: { name: string; structure: BlindLevel[] } | null;
};

// `Record<ClosedTournamentStatus, string>`로 둔다. 리터럴 분기였다면 계약에
// 닫힌 상태가 늘어도 그냥 컴파일이 돼, 새 상태가 폴백(「등록 마감」)으로
// 조용히 떨어진다 — 이 티켓이 없애려던 바로 그 오독이다. `Record`는 계약이
// 상태를 늘리는 순간 이 객체에 키가 빠졌다는 컴파일 에러를 낸다.
const CLOSED_STATUS_LABEL: Record<ClosedTournamentStatus, string> = {
  CANCELLED: '취소된 대회',
  FINISHED: '종료된 대회',
};

async function fetchTournament(id: string): Promise<TournamentDetail | null> {
  const res = await fetch(`${BACKEND_URL}/tournaments/${id}`, { cache: 'no-store' });
  if (!res.ok) return null;
  // 봉투를 벗긴다. 예전에 이걸 빠뜨려 `tournamentId`가 undefined로 나간 적이 있다.
  const envelope = (await res.json()) as { tournament: TournamentDetail | null };
  return envelope.tournament ?? null;
}

/**
 * 참가자 폰의 대회 상세.
 *
 * 좌석을 고르는 화면이 없다 — 좌석 확정이 결제에서 입장으로 옮겨가면서
 * (T28) 좌석 선택 화면과 경합 모달이 함께 사라졌다. 여기서 하는 일은
 * **돈을 내는 것**뿐이고, 자리는 현장에서 정해진다.
 */
export default async function TournamentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tournament = await fetchTournament(id);

  if (!tournament) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="text-[16px] leading-[1.5] tracking-[0.16px] text-[var(--ink-muted)]">
          대회를 찾을 수 없습니다.
        </p>
        <Link
          href="/tournaments"
          className="h-12 border border-[var(--blue)] px-4 text-[14px] leading-[3rem] tracking-[0.16px] text-[var(--blue)] hover:bg-[var(--surface)]"
        >
          대회 찾기
        </Link>
      </div>
    );
  }

  const levels = tournament.blindStructure?.structure ?? [];
  // 중단·취소(`abortSession`·`cancelSession`)는 `isRegistrationOpen` 컬럼을
  // flip하지 않는다 — flip하는 곳은 `closeRegistration` 하나뿐이다. 그래서
  // 컬럼만 보면 취소된 대회도 「등록 열림」으로 보여, 참가 버튼이 살아 있게
  // 된다. 닫힌 상태(`ClosedTournamentStatusSchema`)를 컬럼과 함께 본다.
  const isClosedStatus = (
    ClosedTournamentStatusSchema.options as readonly string[]
  ).includes(tournament.status);
  const closed = !tournament.isRegistrationOpen || isClosedStatus;
  // 서버 복구 중(T96). 결제는 SYNCING을 막지 않는다 — 정지는 블라인드 시계와
  // 딜러 복귀뿐이라, 등록 열림/마감 판정은 그대로 두고 앞에 사실만 덧붙인다.
  const isSyncing = tournament.status === 'SYNCING';

  return (
    <div className="flex flex-col gap-6 p-6 pb-10">
      <div className="flex flex-col gap-3">
        <Link
          href={`/tournaments?store=${tournament.storeId}`}
          className="text-[14px] tracking-[0.16px] text-[var(--blue)] hover:underline"
        >
          ← 이 상점의 다른 대회
        </Link>

        <div className="flex flex-col gap-1">
          {/* Carbon 디스플레이는 weight 300이다. 굵게 하면 여느 화면이 된다. */}
          <h1 className="text-[28px] font-light leading-[1.2]">{tournament.name}</h1>
          {/* 알약을 쓰지 않는다 — Carbon은 사각이다(`DESIGN.md` Don't:
              "Don't use pill-shaped buttons"). 상태는 글자 하나로 충분하고,
              색은 문서가 정한 의미색만 쓴다. */}
          <p
            className={`text-[12px] leading-[1.33] tracking-[0.32px] ${
              closed || isSyncing ? 'text-[var(--ink-subtle)]' : 'text-[var(--ok)]'
            }`}
          >
            {/* 취소·종료를 「등록 마감」 하나로 뭉치면 "등록만 닫혔고 대회는
                돈다"로 읽힌다 — 취소된 대회에는 참가할 대회 자체가 없다.
                열린 쪽(「등록 열림」/「등록 마감」)은 상태가 아니라 `closed`에서
                나오므로 `CLOSED_STATUS_LABEL`에 넣지 않는다.
                SYNCING은 닫힌 상태가 아니라 앞에 「복구 중 · 」만 붙인다 —
                결제는 정지의 영향을 받지 않는다. */}
            {isClosedStatus
              ? CLOSED_STATUS_LABEL[tournament.status as ClosedTournamentStatus]
              : `${isSyncing ? '복구 중 · ' : ''}${closed ? '등록 마감' : '등록 열림'}`}
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-2.5 border-t border-[var(--hairline)] pt-4 text-[14px] tracking-[0.16px]">
        <Row label="참가비" value={tournament.entryFee.toLocaleString()} />
        <Row label="시작 스택" value={tournament.startStack.toLocaleString()} />
        <Row label="리바인" value={`레벨 ${tournament.rebuyUntil}까지`} />
        <Row label="현재 참가" value={`${tournament.totalPlayers}명`} />
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-subtle)]">
          블라인드
        </h2>
        <table className="w-full text-[14px] tracking-[0.16px]">
          <tbody>
            {levels.map((level) => (
              <tr key={level.lv} className="border-t border-[var(--hairline)]">
                <td className="py-2.5">레벨 {level.lv}</td>
                {/* bb는 서버에 없다. sb * 2로 파생한다(contract/dashboard.ts). */}
                <td className="py-2.5 text-right font-mono">
                  {level.sb.toLocaleString()} / {(level.sb * 2).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <JoinPanel
        tournamentId={tournament.id}
        entryFee={tournament.entryFee}
        disabled={closed}
        joinTournament={joinTournament}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--ink-subtle)]">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
