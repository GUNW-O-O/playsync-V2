import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { apiUrl, apiFetch } from '@/lib/api';

describe('apiUrl', () => {
  it('설정된 오리진을 앞에 붙인다', () => {
    expect(apiUrl('/api/tournaments/t1/seats')).toBe(
      'http://localhost:3000/api/tournaments/t1/seats',
    );
  });
});

describe('apiFetch', () => {
  it('상대 경로를 오리진 붙은 요청으로 보낸다', async () => {
    // 전역 목은 없다(`mocks/handlers.ts`) — 이 테스트가 쓰는 응답은 여기서
    // 등록한다. `/api/*`는 `next.config.ts`의 rewrite가 백엔드로 넘기는
    // 경로이고, 여기서는 그 앞단(오리진이 붙어 나가는지)만 본다.
    server.use(
      http.get('*/api/tournaments/:id/seats', () =>
        HttpResponse.json([{ tableId: 'tb1', seatStatus: Array(9).fill(false) }]),
      ),
    );

    const res = await apiFetch('/api/tournaments/t1/seats');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { tableId: 'tb1', seatStatus: Array(9).fill(false) },
    ]);
  });

  it('핸들러가 없는 경로는 에러가 된다', async () => {
    await expect(apiFetch('/api/없는경로')).rejects.toThrow();
  });
});
