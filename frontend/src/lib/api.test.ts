import { describe, it, expect } from 'vitest';
import { apiUrl, apiFetch } from '@/lib/api';

describe('apiUrl', () => {
  it('설정된 오리진을 앞에 붙인다', () => {
    expect(apiUrl('/api/auth/login')).toBe('http://localhost:3000/api/auth/login');
  });
});

describe('apiFetch', () => {
  it('목업 핸들러가 응답한다', async () => {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'tester', password: 'pw' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it('핸들러가 없는 경로는 에러가 된다', async () => {
    await expect(apiFetch('/api/없는경로')).rejects.toThrow();
  });
});
