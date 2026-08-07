import Link from 'next/link';
import { cookies } from 'next/headers';
import OtpReveal from './OtpReveal';

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

/** 대회 상태를 사람이 읽는 말로. 그대로 두면 화면에 `PENDING`이 뜬다. */
function statusLabel(status: string): string {
  if (status === 'ONGOING') return '진행 중';
  if (status === 'PENDING') return '시작 전';
  return '종료';
}

export default async function MyPage() {
  const rows = await fetchParticipations();

  if (rows === null) {
    // 미들웨어가 로그인 자체는 이미 막았으므로 여기까지 온 실패는 토큰
    // 만료거나 백엔드 장애다. 백지 대신 문구를 남긴다.
    return (
      <div className="p-6">
        <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
          내 참가를 불러오지 못했습니다.
        </p>
      </div>
    );
  }

  // 가르는 기준은 대회 상태다. `playerOtp`의 null 여부로 가르면 서버가
  // 그 값을 지우는 조건(`FINISHED`)을 화면이 한 번 더 추측하게 된다.
  const ongoing = rows.filter((r) => r.tournament.status !== 'FINISHED');
  const past = rows.filter((r) => r.tournament.status === 'FINISHED');

  return (
    <div className="flex flex-col gap-8 p-6 pb-10">
      <h1 className="text-[28px] font-light leading-[1.2]">내 참가</h1>

      {rows.length === 0 && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[16px] leading-[1.5] tracking-[0.16px] text-[var(--ink-muted)]">
            참가한 대회가 없습니다.
          </p>
          {/* 빈 화면은 다음 동작을 가리킨다. 대회는 상점에 속하므로
              첫 걸음은 상점을 찾는 것이다. */}
          <Link
            href="/tournaments"
            className="h-12 border border-[var(--blue)] px-4 leading-[3rem] text-[14px] tracking-[0.16px] text-[var(--blue)] hover:bg-[var(--surface)]"
          >
            대회 찾기
          </Link>
        </div>
      )}

      {ongoing.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-subtle)]">
            진행 중
          </h2>

          {ongoing.map((row) => (
            /* Carbon feature-card — 1px 실선, 그림자 없음, 모서리 0px. */
            <article
              key={row.id}
              className="flex flex-col gap-4 border border-[var(--hairline)] p-6"
            >
              <div className="flex flex-col gap-1">
                <h3 className="text-[20px] leading-[1.4]">{row.tournament.name}</h3>
                <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
                  참가비 {row.tournament.entryFee.toLocaleString()} ·{' '}
                  {statusLabel(row.tournament.status)}
                </p>
              </div>

              {row.playerOtp ? (
                <OtpReveal otp={row.playerOtp} />
              ) : (
                /* 서버가 OTP를 지우는 조건은 FINISHED 하나뿐이라 여기까지
                   오는 일은 없어야 한다. 그래도 버튼을 그려 두면 눌러도
                   빈 칸이 뜨는 화면이 된다. */
                <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
                  참가 OTP가 없습니다. 상점에 문의하세요.
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-subtle)]">
            지난 참가
          </h2>

          {/* 표가 아니라 목록이다. 열이 둘뿐이고 폰에서는 각 행이 두 줄로
              접히므로, 표의 정렬이 지켜지지 않는다. */}
          <ul className="border-t border-[var(--hairline)]">
            {past.map((row) => (
              <li
                key={row.id}
                className="flex items-start justify-between gap-4 border-b border-[var(--hairline)] py-4"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-[16px] leading-[1.5] tracking-[0.16px]">
                    {row.tournament.name}
                  </span>
                  <span className="text-[12px] leading-[1.33] tracking-[0.32px] text-[var(--ink-subtle)]">
                    {yyyymmdd(row.tournament.startedAt ?? row.createdAt)}
                  </span>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  {row.finalPlace === null ? (
                    <span className="text-[14px] tracking-[0.16px] text-[var(--ink-subtle)]">
                      탈락
                    </span>
                  ) : (
                    <>
                      <span className="font-mono text-[16px]">{row.finalPlace}위</span>
                      {row.prizeAmount > 0 && (
                        <span className="font-mono text-[12px] text-[var(--ok)]">
                          +{row.prizeAmount.toLocaleString()}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
