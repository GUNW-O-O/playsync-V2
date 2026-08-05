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

const { reissueDealerOtp, startTournament } = await import('./action');

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
