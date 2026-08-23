import { cookies } from 'next/headers';
import {
  FinishPreviewSchema,
  FullTournamentInfoSchema,
  type FinishPreview,
  type FullTournamentInfo,
} from '@playsync/contract';
import ConsoleClient, { type TournamentMeta, type TableInfo, type TableSeatInfo } from './ConsoleClient';
import {
  startTournament,
  openTable,
  closeTable,
  releaseSeats,
  reissueDealerOtp,
  completeTournament,
  chopTournament,
  abortTournament,
  fetchFinishPreview,
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
 * 마무리 미리보기. 좌석 조회와 같은 문(STORE_ADMIN + 소유권 확인)이라
 * 관리자 토큰을 실어 보낸다.
 *
 * **실패를 페이지의 문지기로 쓰지 않는다.** 소유권은 `fetchSeatOccupants`가
 * 이미 본다. 여기서 실패하는 경우는 시작 전 대회처럼 정상적인 것도 있어서,
 * `null`이면 마무리 영역을 안 그리는 것으로 끝난다.
 *
 * 계약을 실제로 태운다 — 되돌릴 수 없는 조작의 근거로 보여줄 숫자라,
 * 모양이 어긋났을 때 조용히 잘못 그리는 것이 가장 나쁘다.
 */
async function fetchPreview(
  tournamentId: string,
  token: string | undefined,
): Promise<FinishPreview | null> {
  if (!token) return null;

  const res = await fetch(`${BACKEND_URL}/store/sessions/${tournamentId}/finish-preview`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const parsed = FinishPreviewSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * 좌석 해제의 입력. `GET /store/sessions/:id/seats`는 STORE_ADMIN 전용
 * 가드가 걸려 있다(다른 운영 조작과 같은 문) — 그래서 관리자의 쿠키
 * 토큰을 Authorization 헤더로 실어 보내야 한다.
 *
 * 미들웨어는 `/stores`에 STORE_ADMIN·PLATFORM_ADMIN을 둘 다 들이지만 이
 * 엔드포인트는 STORE_ADMIN만 통과시킨다 — PLATFORM_ADMIN이 이 화면을 열면
 * 좌석 정보를 아예 못 받는다.
 *
 * 이 실패는 좌석 패널 하나가 아니라 **페이지 전체의 문지기**다(T66). 왜
 * 그렇게 뒀고 왜 PLATFORM_ADMIN에도 예외가 없는지는 아래
 * `ConsoleTournamentPage` 주석에 적었다 — 여기서 두 번 적지 않는다.
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
 * 예외를 두지 않는다 — 소유권 확인이 실패하면(토큰이 없거나, 역할을 못
 * 읽거나, `PLATFORM_ADMIN`이거나) 전부 차단이다. `PLATFORM_ADMIN`도
 * 예외가 아니다: `docs/backlog.md`의 "`GET /store`가 소유자 기준이다"
 * 판단이 어드민이 전체 상점을 보는 경로 자체를 만들지 않기로 정했고,
 * `@Roles`에 `PLATFORM_ADMIN`이 남아 있는 것은 그 판단을 뒤집은 게
 * 아니라 "지금 빼면 나중에 되돌려야 하니 남겨 뒀다"는 잔재일 뿐이다(같은
 * 문서, "`PLATFORM_ADMIN`이 `@Roles`에 남아 있지만 실제로는 전부 403이다").
 * 이 페이지가 그 역할에 구멍을 하나 열어 주면 그 판단과 어긋난다.
 *
 * 나중에 어드민 화면을 실제로 세운다면 그 자리는 여기(페이지 컴포넌트의
 * 분기)가 아니라 컨트롤러다 — `SessionController`가 이미 쓰는 방식대로
 * `@Roles(Role.PLATFORM_ADMIN)`을 해당 라우트에 얹는다. 권한의 진실은
 * 백엔드 한 곳에 두고, 프론트는 그 결과(성공/실패)만 따른다.
 */
export default async function ConsoleTournamentPage({
  params,
}: {
  params: Promise<{ storeId: string; tournamentId: string }>;
}) {
  const { storeId, tournamentId } = await params;
  const token = (await cookies()).get('accessToken')?.value;

  const [tournament, dashboard, tables, seatResult, preview] = await Promise.all([
    fetchTournament(tournamentId),
    fetchDashboard(tournamentId),
    fetchTables(tournamentId),
    fetchSeatOccupants(tournamentId, token),
    fetchPreview(tournamentId, token),
  ]);

  const ownershipDenied = seatResult.seatError !== null;

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
      preview={ownershipDenied ? null : preview}
      completeTournament={completeTournament}
      chopTournament={chopTournament}
      abortTournament={abortTournament}
      fetchFinishPreview={fetchFinishPreview}
    />
  );
}
