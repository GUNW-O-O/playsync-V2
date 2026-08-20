import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { default: ConsoleTournamentPage } = await import('./page');

/** 서명 검증 없이 role만 실은 JWT 모양. `decodeSession`은 서명을 보지 않는다. */
function fakeToken(payload: { sub: string; nickname: string; role: string }): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function useFixtures(seatStatus: number) {
  server.use(
    http.get('http://backend.test/tournaments/trn-1', () =>
      HttpResponse.json({
        tournament: {
          id: 'trn-1',
          name: '남의 대회',
          status: 'PENDING',
          isRegistrationOpen: true,
          rebuyUntil: 5,
          entryFee: 5000,
          startStack: 10000,
        },
        seatStatus: [],
      }),
    ),
    http.get('http://backend.test/dealer/trn-1', () =>
      HttpResponse.json({ id: 'trn-1', tables: [{ id: 'tbl-1', tableOrder: 1 }] }),
    ),
    http.get('http://backend.test/playsync/dashboard/trn-1', () => new HttpResponse('', { status: 200 })),
    http.get('http://backend.test/store/sessions/trn-1/seats', () => {
      if (seatStatus === 200) return HttpResponse.json([]);
      return HttpResponse.json(
        { statusCode: seatStatus, message: seatStatus === 403 ? '본인의 매장이 아닙니다.' : 'Forbidden resource' },
        { status: seatStatus },
      );
    }),
  );
}

/**
 * `/stores/<storeId>/tournaments/<tournamentId>`의 storeId·tournamentId는
 * URL 파라미터라, 예전에는 그 조합이 로그인한 관리자의 것인지 아무도
 * 확인하지 않았다(T66). 미들웨어는 `/stores`에 역할만 보고 URL의 소유권은
 * 안 본다 — 아무 STORE_ADMIN이나 남의 대회를 URL에 적어 열면 대회명·
 * 프라이즈풀·테이블 목록이 그대로 렌더됐다.
 *
 * 소유권의 유일한 서버 판정은 `GET /store/sessions/:id/seats`
 * (`SessionService.assertTournamentOwnership`)다. 여기서는 그 판정을
 * 페이지가 실제로 문지기로 쓰는지 본다.
 */
describe('상점 콘솔 대회 상세 — storeId 소유권(T66)', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
  });

  it('남의 대회면 대회 정보를 아예 내려보내지 않는다', async () => {
    const token = fakeToken({ sub: 'owner-a', nickname: 'A 사장', role: 'STORE_ADMIN' });
    cookieStore.get.mockImplementation((name: string) => (name === 'accessToken' ? { value: token } : undefined));
    useFixtures(403);

    const element = await ConsoleTournamentPage({
      params: Promise.resolve({ storeId: 'store-b', tournamentId: 'trn-1' }),
    });

    expect(element.props.tournament).toBeNull();
    expect(element.props.dashboard).toBeNull();
    expect(element.props.tables).toEqual([]);
    // 이름 문자열이 어디에도 실리지 않는다는 것까지 — prop 이름을 하나
    // 놓쳐도 잡히도록.
    expect(JSON.stringify(element.props)).not.toContain('남의 대회');
  });

  it('본인 대회면 그대로 내려간다', async () => {
    const token = fakeToken({ sub: 'owner-a', nickname: 'A 사장', role: 'STORE_ADMIN' });
    cookieStore.get.mockImplementation((name: string) => (name === 'accessToken' ? { value: token } : undefined));
    useFixtures(200);

    const element = await ConsoleTournamentPage({
      params: Promise.resolve({ storeId: 'store-a', tournamentId: 'trn-1' }),
    });

    expect(element.props.tournament?.name).toBe('남의 대회');
    expect(element.props.tables).toEqual([{ id: 'tbl-1', tableOrder: 1 }]);
  });

  /**
   * `PLATFORM_ADMIN`도 예외가 아니다. `docs/backlog.md`의 "`GET /store`가
   * 소유자 기준이다" 판단이 어드민의 전체 상점 열람 경로 자체를 만들지
   * 않기로 정했다 — `getSeatOccupants`가 `@Roles(Role.STORE_ADMIN)` 전용이라
   * PLATFORM_ADMIN은 소유권과 무관하게 항상 403인데, 그 역할에만 페이지
   * 전체를 열어 주면 그 판단을 이 화면이 뒤집는 것이 된다.
   */
  it('PLATFORM_ADMIN도 소유자가 아니므로 똑같이 차단된다', async () => {
    const token = fakeToken({ sub: 'admin-1', nickname: '플랫폼 관리자', role: 'PLATFORM_ADMIN' });
    cookieStore.get.mockImplementation((name: string) => (name === 'accessToken' ? { value: token } : undefined));
    useFixtures(403);

    const element = await ConsoleTournamentPage({
      params: Promise.resolve({ storeId: 'store-a', tournamentId: 'trn-1' }),
    });

    expect(element.props.tournament).toBeNull();
    expect(element.props.seatError).not.toBeNull();
  });

  it('토큰이 없으면(비정상 접근) 소유권을 확인할 수 없으므로 차단한다', async () => {
    cookieStore.get.mockReturnValue(undefined);
    useFixtures(200); // 토큰이 없어 fetchSeatOccupants가 백엔드를 부르지도 않는다

    const element = await ConsoleTournamentPage({
      params: Promise.resolve({ storeId: 'store-a', tournamentId: 'trn-1' }),
    });

    expect(element.props.seatError).toBe('로그인이 필요합니다.');
    expect(element.props.tournament).toBeNull();
  });
});
