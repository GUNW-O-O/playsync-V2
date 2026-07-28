import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { get: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { POST } = await import('./route');

/**
 * 이 파일 하나가 계획 C의 전제를 지킨다.
 *
 * 액세스 토큰은 여기서만 읽히고, 여기서 밖으로 나가면 안 된다. 나가는 순간
 * 브라우저 JS와 페이지 소스에 토큰이 돌아오고 httpOnly가 다시 무의미해진다.
 */
describe('POST /api/ws-ticket', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    server.use(
      http.post('http://backend.test/ws/ticket', () =>
        HttpResponse.json({ ticket: 'tkt-1' }),
      ),
    );
  });

  it('쿠키가 없으면 401이고 백엔드를 부르지 않는다', async () => {
    let called = false;
    server.use(
      http.post('http://backend.test/ws/ticket', () => {
        called = true;
        return HttpResponse.json({ ticket: 'tkt-1' });
      }),
    );
    cookieStore.get.mockReturnValue(undefined);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  it('쿠키의 토큰을 Bearer로 실어 보낸다', async () => {
    let authorization: string | null = null;
    server.use(
      http.post('http://backend.test/ws/ticket', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ ticket: 'tkt-1' });
      }),
    );
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: 'player-token' } : undefined,
    );

    await POST();

    expect(authorization).toBe('Bearer player-token');
  });

  it('딜러 쿠키가 있으면 그쪽을 먼저 쓴다', async () => {
    let authorization: string | null = null;
    server.use(
      http.post('http://backend.test/ws/ticket', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({ ticket: 'tkt-1' });
      }),
    );
    cookieStore.get.mockImplementation((name: string) =>
      name === 'dealerToken' ? { value: 'dealer-token' } : { value: 'player-token' },
    );

    await POST();

    expect(authorization).toBe('Bearer dealer-token');
  });

  it('응답에는 티켓만 담고 토큰은 담지 않는다', async () => {
    // 백엔드 응답을 그대로 흘려보내면 언젠가 토큰이 섞여 나간다. 키를 골라 담는다.
    server.use(
      http.post('http://backend.test/ws/ticket', () =>
        HttpResponse.json({ ticket: 'tkt-1', accessToken: 'leaked-token' }),
      ),
    );
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: 'player-token' } : undefined,
    );

    const res = await POST();
    const body = await res.json();

    expect(body).toEqual({ ticket: 'tkt-1' });
    expect(JSON.stringify(body)).not.toContain('player-token');
    expect(JSON.stringify(body)).not.toContain('leaked-token');
  });

  it('백엔드가 ticket 없이 200을 주면 스키마 parse가 막고 502를 준다', async () => {
    // WsTicketResponseSchema.parse가 실제로 도는지 확인한다. 안 돌면 이
    // 응답이 그대로 흘러나가 스트립도, 형식 보증도 없어진다.
    server.use(
      http.post('http://backend.test/ws/ticket', () => HttpResponse.json({ ok: true })),
    );
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: 'player-token' } : undefined,
    );

    const res = await POST();

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('player-token');
  });

  it('백엔드 실패는 상태코드와 문구를 그대로 전한다', async () => {
    server.use(
      http.post('http://backend.test/ws/ticket', () =>
        HttpResponse.json({ message: '만료된 딜러 세션입니다.' }, { status: 403 }),
      ),
    );
    cookieStore.get.mockImplementation((name: string) =>
      name === 'accessToken' ? { value: 'player-token' } : undefined,
    );

    const res = await POST();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: '만료된 딜러 세션입니다.' });
  });
});
