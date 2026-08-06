import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/**
 * `GET /user/me/participations`의 행 하나.
 *
 * 모양의 출처는 `backend/src/user/user.service.ts:66-81`이다 —
 * `TournamentParticipation` 행에 `tournament` 관계를
 * `select: { id, name, status, entryFee, startedAt }`로 붙인 것이고,
 * 대회가 `FINISHED`면 서버가 `playerOtp`를 `null`로 지운 뒤 내려보낸다.
 * 화면이 쓰는 것만 추린다.
 */
type Participation = {
  id: string;
  status: string;
  finalPlace: number | null;
  prizeAmount: number;
  playerOtp: string | null;
  createdAt: string;
  tournament: {
    id: string;
    name: string;
    status: string;
    entryFee: number;
    startedAt: string | null;
  };
};

/**
 * 이 화면이 참가 OTP를 읽는 **유일한 곳**이다(T27).
 *
 * OTP는 사람에게 붙는 값이라 좌석에 고정된 태블릿이 아니라 폰에 남는다.
 * 자리를 옮기거나 태블릿이 꺼져도 같은 번호로 돌아온다 — 그래서 한 번
 * 보여주고 지우지 않는다.
 */
async function fetchParticipations(): Promise<Participation[] | null> {
  const token = (await cookies()).get('accessToken')?.value;
  if (!token) return null;

  const res = await fetch(`${BACKEND_URL}/user/me/participations`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as Participation[];
}

function yyyymmdd(iso: string): string {
  return iso.slice(0, 10);
}

export default async function MyPage() {
  const rows = await fetchParticipations();

  if (rows === null) {
    // 미들웨어가 로그인 자체는 이미 막았으므로 여기까지 온 실패는 토큰
    // 만료거나 백엔드 장애다. 백지 대신 문구를 남긴다.
    return (
      <div className="min-h-screen bg-[var(--canvas)] p-6 text-[var(--ink)]">
        <p className="text-sm text-[var(--ink-subtle)]">내 참가를 불러오지 못했습니다.</p>
      </div>
    );
  }

  // 가르는 기준은 대회 상태다. `playerOtp`의 null 여부로 가르면 서버가
  // 그 값을 지우는 조건(`FINISHED`)을 화면이 한 번 더 추측하게 된다.
  const ongoing = rows.filter((r) => r.tournament.status !== 'FINISHED');
  const past = rows.filter((r) => r.tournament.status === 'FINISHED');

  return (
    <div
      className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]"
      style={{ letterSpacing: '0.16px' }}
    >
      <div className="flex flex-col gap-5 p-6">
        {rows.length === 0 && (
          <p className="text-sm text-[var(--ink-subtle)]">참가한 대회가 없습니다.</p>
        )}

        {ongoing.map((row) => (
          <div
            key={row.id}
            className="rounded border border-[var(--blue)] bg-[var(--surface)] p-4"
          >
            <p className="mb-1 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">
              참가 OTP · {row.tournament.name}
            </p>
            {/* 숫자 사이를 벌리는 것은 자간이다. 값 자체에 공백을 넣으면
                태블릿에 옮겨 적는 사람이 그 공백까지 세게 된다. */}
            <div
              className="font-mono text-[36px] leading-[1.15]"
              style={{ letterSpacing: '0.12em' }}
            >
              {row.playerOtp}
            </div>
            <div className="my-3.5 h-px bg-[var(--hairline)]" />
            <p className="text-[13px] text-[var(--ink-subtle)]">
              자리에 앉아 태블릿에 넣는다. <strong>몇 번이든 다시 쓸 수 있다</strong> — 자리를
              옮기거나 태블릿이 꺼져도 이 번호로 돌아온다.
            </p>
          </div>
        ))}

        {past.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] tracking-[0.06em] text-[var(--ink-subtle)]">지난 참가</p>
            <table className="w-full text-sm">
              <tbody>
                {past.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--hairline)]">
                    <td className="py-2.5">
                      <div>{row.tournament.name}</div>
                      <div className="text-[13px] text-[var(--ink-subtle)]">
                        {yyyymmdd(row.tournament.startedAt ?? row.createdAt)}
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono">
                      {row.finalPlace === null ? (
                        <span className="text-[var(--ink-subtle)]">탈락</span>
                      ) : (
                        <>
                          <div>{row.finalPlace}위</div>
                          {row.prizeAmount > 0 && (
                            <div className="text-[13px] text-[var(--ink-subtle)]">
                              +{row.prizeAmount.toLocaleString()}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
