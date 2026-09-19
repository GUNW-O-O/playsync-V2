import { ClosedTournamentStatusSchema, type ClosedTournamentStatus } from '@playsync/contract';
import { decodeBase64Url } from './session';

/**
 * 테이블을 못 불러온 단말이 **닫힌 대회의 테이블**이었는지 찾는다.
 *
 * 대회를 닫는 트랜잭션이 스냅샷과 `Table` 행을 함께 지우므로, 닫힌 직후 다시
 * 뜬 단말은 테이블로는 대회를 찾을 수 없다. 딜러 토큰과 좌석 토큰은 둘 다
 * `tournamentId`를 싣는다 — 그것으로 공개 조회(`GET /tournaments/:id`)를 한 번 한다.
 *
 * 서명은 안 본다(`decodeSession`과 같은 이유). 어떤 화면을 그릴지 고르는 데만
 * 쓰고, 조회하는 라우트는 가드가 없다.
 *
 * 무엇이든 실패하면 `null` — 부르는 쪽이 원래의 실패 안내를 그린다.
 */
export async function findClosedTournament(
  token: string | undefined,
): Promise<{ status: ClosedTournamentStatus; storeId?: string } | null> {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const { tournamentId } = JSON.parse(decodeBase64Url(payload)) as { tournamentId?: unknown };
    if (typeof tournamentId !== 'string') return null;

    const res = await fetch(`${process.env.BACKEND_URL}/tournaments/${tournamentId}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tournament?: { status?: unknown; storeId?: string } };
    const status = ClosedTournamentStatusSchema.safeParse(body.tournament?.status);
    return status.success ? { status: status.data, storeId: body.tournament?.storeId } : null;
  } catch {
    return null;
  }
}
