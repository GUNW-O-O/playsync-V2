import { describe, it, expect } from 'vitest';
import { deviceHeader, deviceStoreId } from './device-token';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (payload: unknown) => `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;

describe('deviceStoreId', () => {
  it('기기 토큰의 storeId를 읽는다', () => {
    expect(deviceStoreId(token({ role: 'STORE_DEVICE', storeId: 'store-1' }))).toBe('store-1');
  });
  it('기기 토큰이 아니면 null', () => {
    expect(deviceStoreId(token({ role: 'PLAYER', storeId: 'store-1' }))).toBeNull();
    expect(deviceStoreId('garbage')).toBeNull();
    expect(deviceStoreId(undefined)).toBeNull();
  });
});

describe('deviceHeader', () => {
  it('토큰이 있으면 헤더 하나, 없으면 빈 객체', () => {
    expect(deviceHeader('t')).toEqual({ 'x-device-token': 't' });
    expect(deviceHeader(undefined)).toEqual({});
  });
});
