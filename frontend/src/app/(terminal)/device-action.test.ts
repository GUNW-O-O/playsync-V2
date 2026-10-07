import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

process.env.BACKEND_URL = 'http://backend.test';
const { registerDevice } = await import('./device-action');

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const DEVICE_TOKEN = `${b64({ alg: 'HS256' })}.${b64({ exp: Date.now() / 1000 + 3600, role: 'STORE_DEVICE', storeId: 'store-1' })}.sig`;

describe('registerDevice', () => {
  let seenAuth: string | null = null;

  beforeEach(() => {
    cookieStore.set.mockReset();
    seenAuth = null;
    server.use(
      http.post('http://backend.test/auth/login', () => HttpResponse.json({ accessToken: 'owner-token' })),
      http.post('http://backend.test/store/store-1/devices', ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ deviceToken: DEVICE_TOKEN }, { status: 201 });
      }),
    );
  });

  it('점주 토큰으로 등록하고 deviceToken만 심는다', async () => {
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'pw' });

    expect(result).toEqual({ ok: true });
    expect(seenAuth).toBe('Bearer owner-token');
    // 점주 세션이 태블릿에 남으면 손님 앞에 점주로 로그인된 기기가 놓인다.
    expect(cookieStore.set.mock.calls.map((c) => c[0])).toEqual(['deviceToken']);
    expect(cookieStore.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, path: '/' });
  });

  it('로그인이 실패하면 백엔드 문구를 돌려주고 아무것도 안 심는다', async () => {
    server.use(
      http.post('http://backend.test/auth/login', () =>
        HttpResponse.json({ message: '아이디 또는 비밀번호가 틀렸습니다.' }, { status: 401 }),
      ),
    );
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'x' });
    expect(result).toEqual({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('남의 상점이면 403 문구를 돌려주고 아무것도 안 심는다', async () => {
    server.use(
      http.post('http://backend.test/store/store-1/devices', () =>
        HttpResponse.json({ message: '본인의 매장이 아닙니다.' }, { status: 403 }),
      ),
    );
    const result = await registerDevice({ storeId: 'store-1', nickname: 'owner', password: 'pw' });
    expect(result).toEqual({ error: '본인의 매장이 아닙니다.' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
