import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

// dealer/action.test.ts와 같은 모양이다 — next/headers는 `set`뿐 아니라
// `get`도 손으로 만든다. 이 파일의 액션들은 가드가 있는 엔드포인트를
// 부르므로 관리자의 accessToken 쿠키를 **읽어야** 한다.
const cookieStore = { set: vi.fn(), get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const {
  reissueDealerOtp, startTournament,
  completeTournament, chopTournament, abortTournament, fetchFinishPreview,
} = await import('./action');

describe('상점 콘솔 서버 액션', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
  });

  /**
   * `table/action.ts`(Task 2)·`dealer/action.ts`(T24)가 세운 규칙: 백엔드
   * 호출에 쓴 토큰은 이 함수 밖으로 나가지 않는다. 여기서 그 토큰은
   * 관리자의 `accessToken`(Authorization 헤더로 실어 보낸 JWT)이다 — 응답이
   * 담아 온 평문 딜러 OTP와는 다른 값이고, 딜러 OTP는 화면에 뜨는 것이
   * 이 엔드포인트의 존재 이유라 반환값에 남아야 한다. 반환값에 없어야 하는
   * 것은 인증에 쓴 관리자 토큰 쪽이다.
   */
  it('재발급 응답의 평문 OTP는 반환값에 있지만 인증에 쓴 토큰은 어디에도 없다', async () => {
    cookieStore.get.mockReturnValue({ value: 'admin-jwt-token' });
    let sentAuth: string | null = null;
    server.use(
      http.post('http://backend.test/store/sessions/t1/dealer-otp/reissue', ({ request }) => {
        sentAuth = request.headers.get('authorization');
        return HttpResponse.json({ dealerOtp: '482913' });
      }),
    );

    const result = await reissueDealerOtp('t1');

    expect(result).toEqual({ ok: true, dealerOtp: '482913' });
    // 인증 헤더에 실제로 실렸는지도 함께 본다 — 그래야 아래 not-toContain이
    // "애초에 안 불렀다"로 우연히 통과하지 않는다.
    expect(sentAuth).toBe('Bearer admin-jwt-token');
    expect(JSON.stringify(result)).not.toContain('admin-jwt-token');
  });

  it('쿠키가 없으면 백엔드를 부르지 않고 실패를 돌려준다', async () => {
    cookieStore.get.mockReturnValue(undefined);
    let called = false;
    server.use(
      http.patch('http://backend.test/store/sessions/t1/start', () => {
        called = true;
        return HttpResponse.json({});
      }),
    );

    const result = await startTournament('t1');

    expect(result).toEqual({ error: '로그인이 필요합니다.' });
    expect(called).toBe(false);
  });
});

describe('마무리 조작', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.get.mockReturnValue({ value: 'admin-jwt-token' });
  });

  /**
   * **되돌릴 수 없는 조작의 실패는 그대로 보여야 한다.** 서버가 「파이널
   * 테이블에서만」이라고 거절했는데 화면이 「요청을 처리하지 못했습니다」로
   * 뭉개면, 상점은 무엇을 고쳐야 다시 될지 모른 채 계속 누른다.
   */
  it('서버가 거절한 이유를 그대로 나른다', async () => {
    server.use(
      http.post('http://backend.test/store/sessions/t1/chop', () =>
        HttpResponse.json(
          { statusCode: 409, message: '파이널 테이블에서만 딜로 끝낼 수 있습니다.' },
          { status: 409 },
        )),
    );

    expect(await chopTournament('t1'))
      .toEqual({ error: '파이널 테이블에서만 딜로 끝낼 수 있습니다.' });
  });

  it('중단은 POST :id/abort를 부른다', async () => {
    let hit = false;
    server.use(
      http.post('http://backend.test/store/sessions/t1/abort', () => {
        hit = true;
        return HttpResponse.json({ refunded: 3, storeAmount: 100, scaled: false });
      }),
    );

    expect(await abortTournament('t1')).toEqual({ ok: true });
    expect(hit).toBe(true);
  });

  it('종료는 PATCH :id/complete를 부른다', async () => {
    let method: string | null = null;
    server.use(
      http.patch('http://backend.test/store/sessions/t1/complete', ({ request }) => {
        method = request.method;
        return HttpResponse.json({});
      }),
    );

    expect(await completeTournament('t1')).toEqual({ ok: true });
    expect(method).toBe('PATCH');
  });

  /**
   * **미리보기는 계약을 태워 읽는다.** 백엔드가 필드를 늘려도 스키마에 없는
   * 것은 화면까지 오지 않고, 모양이 어긋나면 조용히 잘못 그리는 대신 실패로
   * 갈린다 — 되돌릴 수 없는 조작 직전에 보여주는 숫자다.
   */
  it('미리보기가 계약에 안 맞으면 실패로 돌린다', async () => {
    server.use(
      http.get('http://backend.test/store/sessions/t1/finish-preview', () =>
        HttpResponse.json({ totalBuyinAmount: '이상한 값' })),
    );

    const result = await fetchFinishPreview('t1');
    expect('error' in result).toBe(true);
  });

  it('미리보기를 계약대로 받아 온다', async () => {
    server.use(
      http.get('http://backend.test/store/sessions/t1/finish-preview', () =>
        HttpResponse.json({
          totalBuyinAmount: 210000, rakePercent: 10, rakeAmount: 21000,
          prizePool: 189000, paidPrize: 56700, remainingPrize: 132300,
          complete: { canRun: false, reason: '상금 정산이 끝나지 않았습니다. 132300 남았습니다.' },
          chop: {
            canRun: true, reason: null,
            rows: [
              { userId: 'a', nickname: '김민준', place: 1, currentStack: 157500, amount: 99225 },
              { userId: 'b', nickname: '이서연', place: 2, currentStack: 52500, amount: 33075 },
            ],
          },
          abort: {
            canRun: true, reason: null,
            groups: [
              { kind: 'LIVE', count: 2, amount: 21000 },
              { kind: 'FINISHED', count: 14, amount: 73500 },
              { kind: 'PRIZED', count: 1, amount: 0 },
            ],
            storeAmount: 58800, scaled: false,
          },
        })),
    );

    const result = await fetchFinishPreview('t1');
    expect('preview' in result && result.preview.chop.rows[1].amount).toBe(33075);
  });
});
