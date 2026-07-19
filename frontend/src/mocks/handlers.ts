import { http, HttpResponse } from 'msw';

// 목업 JWT. 서명은 아무 값이나 넣는다 — 프론트는 페이로드만 읽고, 검증은
// 백엔드 몫이다.
function fakeToken(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.mock`;
}

// 경로 앞의 `*`는 상대 경로와 절대 경로를 모두 잡는다.
export const handlers = [
  http.post('*/api/auth/login', async ({ request }) => {
    const { nickname } = (await request.json()) as { nickname: string };

    return HttpResponse.json({
      accessToken: fakeToken({
        sub: 'user-1',
        nickname,
        role: 'USER',
      }),
    });
  }),
];
