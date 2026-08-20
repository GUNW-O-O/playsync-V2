import { cookies } from 'next/headers';
import { FullTournamentInfoSchema, type FullTournamentInfo } from '@playsync/contract';
import { decodeSession } from '@/lib/session';
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
 * 이 페이지가 백엔드에서 받는 원본 모양. `payment.service.ts`의
 * `getTournamentInfo`가 `tables`·`blindStructure`까지 select하므로(1번
 * 항목 참고) 콘솔이 실제로 쓰는 것보다 필드가 많다. TS 타입(`TournamentMeta`)만
 * 좁혀 두고 그대로 클라이언트 컴포넌트에 넘기면, 컴파일 시점 계약과 달리
 * RSC 페이로드에는 이 원본 행 전체가 그대로 직렬화된다 — 그래서 아래
 * `toTournamentMeta`로 화면이 쓰는 필드만 직접 골라 넘긴다.
 */
type RawTournament = TournamentMeta & Record<string, unknown>;

/** `GET /dealer/:tournamentId`의 `tables` 원소 — 대회 시작 시각 등 관리용
 * 컬럼까지 그대로 붙어 있다. `RawTournament`와 같은 이유로 좁혀 넘긴다. */
type RawTable = TableInfo & Record<string, unknown>;

function toTournamentMeta(row: RawTournament): TournamentMeta {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    isRegistrationOpen: row.isRegistrationOpen,
    rebuyUntil: row.rebuyUntil,
    entryFee: row.entryFee,
    startStack: row.startStack,
  };
}

function toTableInfo(row: RawTable): TableInfo {
  return { id: row.id, tableOrder: row.tableOrder };
}

/**
 * 대회 메타. `GET /tournaments/:id`가 주는 `{ tournament, seatStatus }`
 * 봉투(`payment.service.ts`의 `getTournamentInfo`)의 `tournament` 쪽이다 —
 * 화면이 쓰는 필드만 `toTournamentMeta`로 추려 넘긴다.
 */
async function fetchTournament(tournamentId: string): Promise<TournamentMeta | null> {
  const res = await fetch(`${BACKEND_URL}/tournaments/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const envelope = (await res.json()) as { tournament: RawTournament | null };
  return envelope.tournament ? toTournamentMeta(envelope.tournament) : null;
}

/** `GET /dealer/:tournamentId` — 대회 필드 + `tables`(`tableOrder` 포함) 평평한 객체다. */
async function fetchTables(tournamentId: string): Promise<TableInfo[]> {
  const res = await fetch(`${BACKEND_URL}/dealer/${tournamentId}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as { tables?: RawTable[] };
  return (data.tables ?? []).map(toTableInfo);
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
 * 돌려준 실패 문구를 그대로 배너로 띄운다.
 *
 * 이 어긋남은 T56이 **그대로 두기로 판단한 것**이다. 어드민 기능 자체가
 * 범위 밖이라(`backlog.md` B6) PLATFORM_ADMIN은 소유자가 아니어서 이 화면의
 * 어떤 조회·조작도 통과하지 못한다. `@Roles`에서 빼는 쪽은 어드민을 세울 때
 * 되돌려야 하므로 그때 같이 정한다.
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
 *
 * `storeId`·`tournamentId`는 URL 파라미터라 그 조합이 로그인한 관리자의
 * 것인지 아무도 확인하지 않았다(T66). 미들웨어(`ROLE_RULES`)는 `/stores`에
 * **역할만** 보고 URL의 소유권은 안 본다 — 아무 `STORE_ADMIN`이나
 * `/stores/<남의 상점>/tournaments/<남의 대회>`를 열면 대회명·상태·
 * 프라이즈풀·테이블 목록·블라인드 시계가 그대로 렌더됐다.
 *
 * 소유권을 서버에서 확인하는 유일한 경로는 `fetchSeatOccupants`가 부르는
 * `GET /store/sessions/:id/seats`다(`SessionService.assertTournamentOwnership`
 * 가 첫 문장). 그 결과를 좌석 패널 하나가 아니라 **페이지 전체**의 문지기로
 * 쓴다 — 다른 세 조회(`fetchTournament`·`fetchTables`·`fetchDashboard`)는
 * 가드가 없어 소유권과 무관하게 성공하므로, 그쪽 결과를 그대로 내려보내면
 * 소유권 확인이 있으나 마나가 된다.
 *
 * `PLATFORM_ADMIN`은 예외다. `getSeatOccupants`가 `@Roles(Role.STORE_ADMIN)`
 * 전용이라 PLATFORM_ADMIN은 소유권과 무관하게 항상 403이고, 그 실패를
 * 페이지 전체로 넓히면 T56이 "그대로 두기로" 정한 어긋남(좌석 패널만 배너,
 * 나머지는 보임 — `getStoreDetail`·상점 경계 절 참고)을 이 기능이 뒤집는다.
 * 그래서 실패는 기본이 차단이고, **PLATFORM_ADMIN만** 예외로 뺀다(토큰이
 * 없거나 역할을 못 읽는 경우도 차단 쪽이다 — 소유권을 확인 못 했으면 안
 * 보여주는 쪽이 안전하다). 역할 판정은 `decodeSession`으로 토큰을 그대로
 * 디코드한다(`lib/session.ts`) — 서명 검증이 아니라 화면 분기용이고, 실제
 * 권한은 여전히 `getSeatOccupants`의 서버 판정이 진다.
 */
export default async function ConsoleTournamentPage({
  params,
}: {
  params: Promise<{ storeId: string; tournamentId: string }>;
}) {
  const { storeId, tournamentId } = await params;
  const token = (await cookies()).get('accessToken')?.value;
  const role = decodeSession(token)?.role;

  const [tournament, dashboard, tables, seatResult] = await Promise.all([
    fetchTournament(tournamentId),
    fetchDashboard(tournamentId),
    fetchTables(tournamentId),
    fetchSeatOccupants(tournamentId, token),
  ]);

  const ownershipDenied = seatResult.seatError !== null && role !== 'PLATFORM_ADMIN';

  return (
    <ConsoleClient
      storeId={storeId}
      tournamentId={tournamentId}
      tournament={ownershipDenied ? null : tournament}
      dashboard={ownershipDenied ? null : dashboard}
      tables={ownershipDenied ? [] : tables}
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
