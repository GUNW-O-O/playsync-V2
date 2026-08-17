import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { enterSeat } = await import('./action');

const INPUT = { tournamentId: 'trnmt-1', tableId: 'tbl-7', seatIndex: 3, otp: '012345' };

const NOW = 1_700_000_000_000;
function tokenExpiringIn(seconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: NOW / 1000 + seconds })}.sig`;
}
/** 좌석 토큰도 12시간이다(`auth/token-ttl.ts`의 `SEAT_ROLE`). */
const SEAT_TOKEN = tokenExpiringIn(12 * 60 * 60);

describe('enterSeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
    server.use(
      http.post('http://backend.test/tournaments/trnmt-1/enter', () =>
        HttpResponse.json({ accessToken: SEAT_TOKEN }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * T54. 쿠키가 한 시간, 토큰이 열두 시간이었다. 좌석 태블릿은 참가가 끝날
   * 때까지 켜져 있으므로 **모든 좌석이** 한 시간마다 OTP를 다시 넣어야 했다
   * — T43이 토큰 수명을 늘려 없앤 증상이 프론트에서 그대로 살아 있었다.
   */
  it('쿠키 수명을 토큰의 exp에서 뽑는다', async () => {
    await enterSeat(INPUT);

    expect(cookieStore.set).toHaveBeenCalledWith(
      'accessToken',
      SEAT_TOKEN,
      expect.objectContaining({ httpOnly: true, path: '/', maxAge: 12 * 60 * 60 }),
    );
  });

  /**
   * **이 태블릿이 아까 딜러였을 수 있다.**
   *
   * 딜러 태블릿이 고장 나면 좌석 태블릿을 딜러용으로 돌려 쓰고, 그 반대도
   * 일어난다. 그런데 `dealerToken`을 지우는 경로가 없었고
   * `api/ws-ticket/route.ts`는 `dealerToken`을 **먼저** 본다. 그래서 좌석으로
   * 되돌린 태블릿이 손님의 좌석 토큰 대신 옛 딜러 토큰으로 티켓을 받고,
   * 게이트웨이가 `payload.tableId !== tableId`로 1008을 던진다 — 그 자리는
   * 쿠키가 만료될 때까지 못 붙는다. 수명을 12시간으로 맞추면 그 창도 12시간이
   * 되므로, 수명 수정과 **같은 티켓에서** 닫아야 한다.
   */
  it('좌석으로 입장하면 옛 딜러 토큰을 지운다', async () => {
    await enterSeat(INPUT);

    expect(cookieStore.delete).toHaveBeenCalledWith('dealerToken');
  });

  it('실패하면 쿠키를 심지도 지우지도 않는다', async () => {
    server.use(
      http.post('http://backend.test/tournaments/trnmt-1/enter', () =>
        HttpResponse.json({ message: '이미 사용 중인 좌석입니다.' }, { status: 409 }),
      ),
    );

    const result = await enterSeat(INPUT);

    expect({
      set: cookieStore.set.mock.calls.length,
      deleted: cookieStore.delete.mock.calls.length,
      result,
    }).toEqual({ set: 0, deleted: 0, result: { error: '이미 사용 중인 좌석입니다.' } });
  });
});
