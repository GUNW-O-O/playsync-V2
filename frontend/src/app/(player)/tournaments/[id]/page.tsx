import Link from 'next/link';
import JoinPanel from './JoinPanel';
import { joinTournament } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/** `BlindStructure.structure`의 원소. `bb`는 없다 — `sb * 2`로 파생한다. */
type BlindLevel = { lv: number; sb: number; ante: boolean; duration: number };

/**
 * `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }` 봉투
 * (`backend/src/payment/payment.service.ts:64`)의 `tournament` 쪽.
 * `SessionService.getGameSession`이 만드는 값이라 필드가 이보다 많고,
 * 화면이 쓰는 것만 추린다. `dealerOtpHash`는 그 쿼리의 `omit`이 이미 뺀다.
 */
type TournamentDetail = {
  id: string;
  name: string;
  status: string;
  isRegistrationOpen: boolean;
  entryFee: number;
  startStack: number;
  rebuyUntil: number;
  totalPlayers: number;
  activePlayers: number;
  storeId: string;
  blindStructure: { name: string; structure: BlindLevel[] } | null;
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
  const closed = !tournament.isRegistrationOpen || tournament.status === 'FINISHED';

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
              closed ? 'text-[var(--ink-subtle)]' : 'text-[var(--ok)]'
            }`}
          >
            {closed ? '등록 마감' : '등록 열림'}
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
