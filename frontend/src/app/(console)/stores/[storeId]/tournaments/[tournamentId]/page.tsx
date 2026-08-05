import { cookies } from 'next/headers';
import { FullTournamentInfoSchema, type FullTournamentInfo } from '@playsync/contract';
import ConsoleClient, { type TournamentMeta, type TableInfo, type TableSeatInfo } from './ConsoleClient';
import {
  startTournament,
  openTable,
  closeTable,
  releaseSeats,
  reissueDealerOtp,
} from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/** `table/action.ts`·`dealer/action.ts`의 `failureMessage`와 같은 모양이다. */
function failureMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return '요청을 처리하지 못했습니다.';
}

/**
 * 대회 메타. `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }`
 * 봉투(`payment.service.ts:64`)의 `tournament` 쪽이다 — `SessionService.
 * getGameSession`이 만드는 값이라 필드가 이보다 많지만, 콘솔이 쓰는 것만 든다.
 */
async function fetchTournament(tournamentId: string): Promise<TournamentMeta | null> {
  const res = await fetch(`${BACKEND_URL}/tournaments/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const envelope = (await res.json()) as { tournament: TournamentMeta | null };
  return envelope.tournament ?? null;
}

/** `GET /dealer/:tournamentId` — 대회 필드 + `tables`(`tableOrder` 포함) 평평한 객체다. */
async function fetchTables(tournamentId: string): Promise<TableInfo[]> {
  const res = await fetch(`${BACKEND_URL}/dealer/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as { tables?: TableInfo[] };
  return data.tables ?? [];
}

/**
 * 대시보드 조회. 시작 전에는 Redis 스냅샷이 없어 빈 본문 200이 나간다
 * (`DisplayClient.tsx`가 다루는 것과 같은 함정) — `res.json()`은 빈 본문에서
 * 파싱 에러로 죽으므로 텍스트를 먼저 본다.
 */
async function fetchDashboard(tournamentId: string): Promise<FullTournamentInfo | null> {
  const res = await fetch(`${BACKEND_URL}/playsync/dashboard/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    const parsed = FullTournamentInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 좌석 해제의 입력. `GET /store/sessions/:id/seats`는 STORE_ADMIN 전용
 * 가드가 걸려 있다(다른 운영 조작과 같은 문) — 그래서 관리자의 쿠키
 * 토큰을 Authorization 헤더로 실어 보내야 한다.
 *
 * 미들웨어는 `/stores`에 STORE_ADMIN·PLATFORM_ADMIN을 둘 다 들이지만 이
 * 엔드포인트는 STORE_ADMIN만 통과시킨다 — PLATFORM_ADMIN이 이 화면을 열면
 * 좌석 정보를 아예 못 받는다. 화면에서 역할 분기로 숨기지 않고, 서버가
 * 돌려준 실패 문구를 그대로 배너로 띄운다(이 어긋남 자체는 이 티켓에서
 * 고칠 것이 아니다 — 브리프·보고서 참고).
 */
async function fetchSeatOccupants(
  tournamentId: string,
  token: string | undefined,
): Promise<{ seatOccupants: TableSeatInfo[]; seatError: string | null }> {
  if (!token) return { seatOccupants: [], seatError: '로그인이 필요합니다.' };

  const res = await fetch(`${BACKEND_URL}/store/sessions/${tournamentId}/seats`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return { seatOccupants: (await res.json()) as TableSeatInfo[], seatError: null };

  const body = await res.json().catch(() => null);
  return { seatOccupants: [], seatError: failureMessage(body) };
}

/**
 * 상점 콘솔의 대회 상세. 서버 컴포넌트에서 직접 백엔드로 네 번 조회한다.
 * 조작 다섯 개는 전부 서버 액션(`./action.ts`)이 맡는다.
 */
export default async function ConsoleTournamentPage({
  params,
}: {
  params: Promise<{ storeId: string; tournamentId: string }>;
}) {
  const { storeId, tournamentId } = await params;
  const token = (await cookies()).get('accessToken')?.value;

  const [tournament, dashboard, tables, seatResult] = await Promise.all([
    fetchTournament(tournamentId),
    fetchDashboard(tournamentId),
    fetchTables(tournamentId),
    fetchSeatOccupants(tournamentId, token),
  ]);

  return (
    <ConsoleClient
      storeId={storeId}
      tournamentId={tournamentId}
      tournament={tournament}
      dashboard={dashboard}
      tables={tables}
      seatOccupants={seatResult.seatOccupants}
      seatError={seatResult.seatError}
      startTournament={startTournament}
      openTable={openTable}
      closeTable={closeTable}
      releaseSeats={releaseSeats}
      reissueDealerOtp={reissueDealerOtp}
    />
  );
}
