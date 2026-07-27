import { describe, it, expect } from 'vitest';
import { decodeSession } from '@/lib/session';

function makeToken(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

describe('decodeSession', () => {
  it('페이로드에서 세션을 뽑는다', () => {
    const token = makeToken({
      sub: 'user-1',
      nickname: '건우',
      role: 'STORE_ADMIN',
    });

    expect(decodeSession(token)).toEqual({
      userId: 'user-1',
      nickname: '건우',
      role: 'STORE_ADMIN',
    });
  });

  it('토큰이 없으면 null', () => {
    expect(decodeSession(undefined)).toBeNull();
  });

  it('형식이 깨진 토큰은 null', () => {
    expect(decodeSession('망가진문자열')).toBeNull();
  });

  it('페이로드가 base64가 아니면 null', () => {
    expect(decodeSession('a.!!!.c')).toBeNull();
  });

  it('모르는 역할은 null', () => {
    const token = makeToken({ sub: 'u', nickname: 'n', role: 'GOD' });
    expect(decodeSession(token)).toBeNull();
  });

  it('필수 필드가 빠지면 null', () => {
    const token = makeToken({ sub: 'u', role: 'USER' });
    expect(decodeSession(token)).toBeNull();
  });
});
