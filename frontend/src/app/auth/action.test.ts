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

/**
 * T92. 상한(429)에 걸리면 백엔드 본문의 `message`가 그대로
 * `ThrottlerException: Too Many Requests`다 — 영어 예외 이름이다. 화면은
 * 이 문구를 참가자에게 보여줄 말로 바꿔야 하고, `Retry-After` 헤더가 있으면
 * 몇 초 뒤에 다시 시도하면 되는지를 그 안에 얹는다.
 *
 * 세 번째 검사(401)가 없으면 429 분기를 모든 실패에 걸어도 이 파일의 다른
 * 검사는 초록으로 남는다(T29) — 그래서 "상한이 아닌 실패는 그대로"를 따로
 * 못 박는다.
 *
 * **헤더에 먹이는 초는 17이다.** 제품 어디에도 없는 값이라야 "헤더에서
 * 읽었다"가 증명된다 — 처음엔 30을 먹였는데 그것이 블록 기본값과 같아,
 * 헤더 읽기를 지우고 상수 30을 박아도 검사가 전부 초록이었다. 짝이 되는
 * 반대 입력이 아래 "헤더가 없으면 초를 지어내지 않는다"다.
 */
describe.each([
  ['handleLogin', handleLogin, 'http://backend.test/auth/login'] as const,
  ['handleRegister', handleRegister, 'http://backend.test/auth/join'] as const,
])('%s — 요청율 상한(429) 안내', (_name, action, url) => {
  beforeEach(() => {
    cookieStore.set.mockReset();
  });

  const THROTTLED_BODY = { statusCode: 429, message: 'ThrottlerException: Too Many Requests' };

  it('상한에 걸리면 다시 시도할 시각을 안내한다', async () => {
    server.use(
      http.post(url, () =>
        HttpResponse.json(THROTTLED_BODY, { status: 429, headers: { 'Retry-After': '17' } }),
      ),
    );

    const result = (await action(CREDENTIALS)) as { error?: string };

    expect(result.error).toEqual(expect.any(String));
    expect(result.error).not.toMatch(/ThrottlerException/i);
    expect(result.error).toContain('17초');
  });

  it('Retry-After가 없으면 초를 지어내지 않는다', async () => {
    server.use(http.post(url, () => HttpResponse.json(THROTTLED_BODY, { status: 429 })));

    const result = (await action(CREDENTIALS)) as { error?: string };

    expect(result.error).toEqual(expect.any(String));
    expect(result.error).not.toMatch(/ThrottlerException/i);
    expect(result.error).not.toMatch(/[0-9]/);
  });

  it('상한이 아닌 실패는 지금 문구 그대로다', async () => {
    server.use(
      http.post(url, () =>
        HttpResponse.json({ statusCode: 401, message: '원래 문구 그대로' }, { status: 401 }),
      ),
    );

    await expect(action(CREDENTIALS)).resolves.toEqual({ error: '원래 문구 그대로' });
  });
});
