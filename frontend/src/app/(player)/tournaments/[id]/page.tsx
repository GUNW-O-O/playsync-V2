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
      <div className="min-h-screen bg-[var(--canvas)] p-6 text-[var(--ink)]">
        <p className="text-sm text-[var(--ink-subtle)]">대회를 찾을 수 없습니다.</p>
      </div>
    );
  }

  const levels = tournament.blindStructure?.structure ?? [];
  const closed = !tournament.isRegistrationOpen || tournament.status === 'FINISHED';

  return (
    <div
      className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]"
      style={{ letterSpacing: '0.16px' }}
    >
      <div className="flex flex-col gap-4 p-6">
        <div>
          <div className="text-[23px] font-light leading-[1.2]">{tournament.name}</div>
          <div className="mt-2">
            <span
              className={
                closed
                  ? 'inline-flex rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--ink-subtle)]'
                  : 'inline-flex rounded-full bg-[rgba(36,161,72,0.12)] px-2.5 py-1 text-xs text-[var(--ok)]'
              }
            >
              {closed ? '등록 마감' : '등록 열림'}
            </span>
          </div>
        </div>

        <div className="h-px bg-[var(--hairline)]" />

        <dl className="flex flex-col gap-2.5 text-sm">
          <Row label="참가비" value={tournament.entryFee.toLocaleString()} />
          <Row label="시작 스택" value={tournament.startStack.toLocaleString()} />
          <Row label="리바인" value={`레벨 ${tournament.rebuyUntil}까지`} />
          <Row label="현재 참가" value={`${tournament.totalPlayers}명`} />
        </dl>

        <div className="h-px bg-[var(--hairline)]" />

        <div>
          <p className="mb-2 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">블라인드</p>
          <table className="w-full text-sm">
            <tbody>
              {levels.map((level) => (
                <tr key={level.lv} className="border-t border-[var(--hairline)]">
                  <td className="py-2">레벨 {level.lv}</td>
                  {/* bb는 서버에 없다. sb * 2로 파생한다(contract/dashboard.ts). */}
                  <td className="py-2 text-right font-mono">
                    {level.sb.toLocaleString()} / {(level.sb * 2).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <JoinPanel
          tournamentId={tournament.id}
          entryFee={tournament.entryFee}
          disabled={closed}
          joinTournament={joinTournament}
        />
      </div>
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
