import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

process.env.BACKEND_URL = 'http://backend.test';

const { handleLogin, handleRegister } = await import('./action');

function formOf(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

const CREDENTIALS = formOf({ nickname: '가나다', password: 'pw' });

/**
 * 두 액션 모두 `res.ok`를 확인하기 **전에** `await res.json()`을 했다.
 * 프록시가 끊은 502나 rate-limit가 돌려주는 HTML이 오면 그 자리에서 던지고,
 * 서버 액션이 던지면 화면에는 빈 에러 바운더리가 뜬다 — 로그인 화면이
 * 통째로 사라져 참가자가 되돌아갈 곳이 없다.
 *
 * 리포의 다른 액션 파일(`dealer/action.ts` · `(terminal)/table/action.ts`)은
 * 전부 `.catch(() => null)` + `failureMessage`를 쓴다. 그 관행에 맞춘다.
 */
describe('auth 액션 — JSON이 아닌 실패 응답', () => {
  beforeEach(() => {
    cookieStore.set.mockReset();
  });

  const NOT_JSON = new HttpResponse('<html><body>502 Bad Gateway</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

  it('handleLogin이 던지지 않고 실패 문구를 돌려준다', async () => {
    server.use(http.post('http://backend.test/auth/login', () => NOT_JSON.clone()));

    const result = await handleLogin(CREDENTIALS);

    expect(result).toEqual({ error: expect.any(String) });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('handleRegister가 던지지 않고 실패 문구를 돌려준다', async () => {
    server.use(http.post('http://backend.test/auth/join', () => NOT_JSON.clone()));

    const result = await handleRegister(CREDENTIALS);

    expect(result).toEqual({ error: expect.any(String) });
  });

  /**
   * 반대 입력. 백엔드가 문구를 실어 보내면 **그 문구가 그대로** 떠야 한다 —
   * 위 둘만 있으면 "언제나 기본 문구"로 고쳐도 초록이다.
   */
  it('백엔드가 준 문구는 그대로 돌려준다', async () => {
    server.use(
      http.post('http://backend.test/auth/login', () =>
        HttpResponse.json({ statusCode: 401, message: '아이디 또는 비밀번호가 틀렸습니다.' }, { status: 401 }),
      ),
      http.post('http://backend.test/auth/join', () =>
        HttpResponse.json({ statusCode: 409, message: '이미 사용 중인 닉네임입니다.' }, { status: 409 }),
      ),
    );

    await expect(handleLogin(CREDENTIALS)).resolves.toEqual({
      error: '아이디 또는 비밀번호가 틀렸습니다.',
    });
    await expect(handleRegister(CREDENTIALS)).resolves.toEqual({
      error: '이미 사용 중인 닉네임입니다.',
    });
  });

  /**
   * ValidationPipe는 `message`를 **배열**로 낸다. 배열을 그대로 두면 화면에
   * `[object Object]`가 아니라 쉼표로 이어 붙은 값이 뜨는데, 다른 액션
   * 파일의 `failureMessage`는 공백으로 잇는다. 같은 모양으로 맞춘다.
   */
  it('ValidationPipe의 문자열 배열도 한 문장으로 잇는다', async () => {
    server.use(
      http.post('http://backend.test/auth/join', () =>
        HttpResponse.json(
          { statusCode: 400, message: ['닉네임은 2자 이상입니다.', '비밀번호가 짧습니다.'] },
          { status: 400 },
        ),
      ),
    );

    await expect(handleRegister(CREDENTIALS)).resolves.toEqual({
      error: '닉네임은 2자 이상입니다. 비밀번호가 짧습니다.',
    });
  });
});
