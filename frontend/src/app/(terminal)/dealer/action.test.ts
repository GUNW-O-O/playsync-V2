import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { authenticateDealer } = await import('./action');

const INPUT = { tournamentId: 'trnmt-1', tableId: 'tbl-7', otp: '012345' };

/** 12시간짜리 딜러 토큰. 서명은 검증되지 않으므로 모양만 맞으면 된다. */
const NOW = 1_700_000_000_000;
function tokenExpiringIn(seconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: NOW / 1000 + seconds })}.sig`;
}
const DEALER_TOKEN = tokenExpiringIn(12 * 60 * 60);

describe('authenticateDealer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cookieStore.set.mockReset();
    cookieStore.delete.mockReset();
    server.use(
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json({ accessToken: 'dealer-token' }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * T54. 쿠키 수명을 상수로 적으면 백엔드가 토큰 수명을 바꿀 때 조용히
   * 어긋난다 — 실제로 T43에서 그랬다(토큰 12시간, 쿠키 1시간). 딜러 태블릿이
   * 한 시간 만에 자격을 잃고 대회 도중 OTP를 다시 넣어야 했다.
   */
  it('쿠키 수명을 토큰의 exp에서 뽑는다', async () => {
    server.use(
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json({ accessToken: DEALER_TOKEN }),
      ),
    );

    await authenticateDealer(INPUT);

    expect(cookieStore.set).toHaveBeenCalledWith(
      'dealerToken',
      DEALER_TOKEN,
      expect.objectContaining({ maxAge: 12 * 60 * 60 }),
    );
  });

  /**
   * 태블릿 하나는 한 번에 한 자리다. 딜러 태블릿이 고장 나 좌석 태블릿을
   * 딜러용으로 돌려 쓰는 일이 실제로 있고, 그때 옛 `accessToken`이 남아
   * 있으면 이 기기의 역할이 두 개가 된다.
   *
   * 우선순위가 `dealerToken`을 먼저 보므로(`api/ws-ticket/route.ts`) 이
   * 방향에서는 아직 안 물리지만, 반대 방향(`enterSeat`)과 규칙을 같게 둔다 —
   * **마지막에 인증한 역할이 그 태블릿의 역할이다.**
   */
  it('딜러로 인증하면 좌석·사용자 토큰을 지운다', async () => {
    await authenticateDealer(INPUT);

    expect(cookieStore.delete).toHaveBeenCalledWith('accessToken');
  });

  it('성공하면 딜러 토큰을 httpOnly 쿠키로 심는다', async () => {
    // js-cookie로 심던 시절 이 토큰은 document.cookie로 읽혔다. XSS 하나면
    // 승자 지정 권한을 가진 토큰이 그대로 나간다.
    const result = await authenticateDealer(INPUT);

    expect(result).toEqual({ ok: true });
    expect(cookieStore.set).toHaveBeenCalledWith(
      'dealerToken',
      'dealer-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('OTP를 숫자가 아니라 문자열로 보낸다', async () => {
    // 백엔드 DTO가 `@Matches(/^[0-9]{6}$/)`로 문자열만 받는다. 앞자리 0이
    // 유효한 값인데 숫자로 보내면 그 자리가 사라진다.
    let sentBody: unknown;
    server.use(
      http.post('http://backend.test/dealer/auth', async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ accessToken: 'dealer-token' });
      }),
    );

    await authenticateDealer(INPUT);

    expect((sentBody as { otp: unknown }).otp).toBe('012345');
  });

  it('실패하면 쿠키를 심지 않고 백엔드 문구를 돌려준다', async () => {
    // 백엔드는 실패를 네 가지로 가른다 — 401 자격 오류, 403 시도 초과(5분
    // 잠금), 403 종료된 대회, 409 딜러 세션 미준비. 잠긴 딜러에게 OTP를
    // 확인하라고 말하면 다시 넣어보게 되고, 그 시도가 다음 창까지 태운다.
    server.use(
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json(
          { message: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.' },
          { status: 403 },
        ),
      ),
    );

    const result = await authenticateDealer(INPUT);

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하거나 상점에 문의해주세요.',
    });
  });

  it('본문에 message가 없으면 기본 문구로 떨어진다', async () => {
    // 백엔드가 아니라 프록시·게이트웨이가 끊은 경우다. 안내가 사라지면 안 된다.
    server.use(
      http.post('http://backend.test/dealer/auth', () =>
        HttpResponse.json({}, { status: 502 }),
      ),
    );

    const result = await authenticateDealer(INPUT);

    expect(result).toEqual({ error: 'OTP를 확인하세요.' });
  });
});
