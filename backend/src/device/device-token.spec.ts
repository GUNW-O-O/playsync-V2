import { JwtService } from '@nestjs/jwt';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { deviceTokenFrom, signDeviceToken, verifyDeviceToken } from './device-token';

const jwt = new JwtService({ secret: 'device-spec-secret' });

describe('기기 토큰', () => {
  it('서명한 토큰을 검증하면 상점과 버전이 돌아온다', () => {
    const token = signDeviceToken(jwt, { storeId: 'store-1', ver: 3 });
    const payload = verifyDeviceToken(jwt, token);
    expect(`${payload?.storeId}/${payload?.ver}`).toBe('store-1/3');
    expect(payload?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('발급마다 기기 id가 다르다 — 버킷을 가르는 열쇠다', () => {
    const a = verifyDeviceToken(jwt, signDeviceToken(jwt, { storeId: 's', ver: 0 }));
    const b = verifyDeviceToken(jwt, signDeviceToken(jwt, { storeId: 's', ver: 0 }));
    expect(a?.deviceId).not.toBe(b?.deviceId);
  });

  it('깨진 문자열 · 없는 값은 null', () => {
    expect(verifyDeviceToken(jwt, 'garbage')).toBeNull();
    expect(verifyDeviceToken(jwt, undefined)).toBeNull();
  });

  it('다른 키로 서명한 토큰은 null', () => {
    const other = new JwtService({ secret: 'other' });
    expect(verifyDeviceToken(jwt, signDeviceToken(other, { storeId: 's', ver: 0 }))).toBeNull();
  });

  it('좌석 토큰 · 사용자 토큰은 기기 토큰이 아니다', () => {
    const seat = jwt.sign({ sub: 'u', role: SEAT_ROLE, storeId: 's', ver: 0 });
    const user = jwt.sign({ sub: 'u', role: 'STORE_ADMIN', storeId: 's', ver: 0 });
    expect(verifyDeviceToken(jwt, seat)).toBeNull();
    expect(verifyDeviceToken(jwt, user)).toBeNull();
  });

  it('헤더가 우선이고, 없으면 쿠키에서 읽는다', () => {
    expect(deviceTokenFrom({ headers: { 'x-device-token': 'h', cookie: 'deviceToken=c' } })).toBe('h');
    expect(deviceTokenFrom({ headers: { cookie: 'a=1; deviceToken=c; b=2' } })).toBe('c');
    expect(deviceTokenFrom({ headers: { cookie: 'xdeviceToken=nope' } })).toBeUndefined();
    expect(deviceTokenFrom({ headers: {} })).toBeUndefined();
    expect(deviceTokenFrom({})).toBeUndefined();
  });
});
