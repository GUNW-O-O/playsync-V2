// 브라우저에서는 빈 문자열이라 상대 경로 그대로 나가고, next.config.ts의
// rewrite가 백엔드로 넘긴다. 테스트 환경에서는 상대 경로 fetch가 불가능하므로
// vitest.setup.ts가 오리진을 채워 준다.
export function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? '';
  return `${base}${path}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
  });
}
