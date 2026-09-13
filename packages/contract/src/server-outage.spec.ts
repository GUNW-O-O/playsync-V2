import {
  SERVER_OUTAGE_EVENT,
  SERVER_RECOVERING_MESSAGE,
  SERVER_RECOVERING_STATUS,
  ServerOutageSchema,
} from './server-outage';

describe('serverOutage', () => {
  it('down 하나만 싣는다', () => {
    expect(ServerOutageSchema.parse({ down: true, extra: 1 })).toEqual({ down: true });
  });
  it('down이 없으면 거부한다', () => {
    expect(ServerOutageSchema.safeParse({}).success).toBe(false);
  });
  it('이름 · 상태 코드 · 문구', () => {
    expect(SERVER_OUTAGE_EVENT).toBe('serverOutage');
    expect(SERVER_RECOVERING_STATUS).toBe(503);
    expect(SERVER_RECOVERING_MESSAGE).toBe('서버 장애를 복구하는 중입니다.');
  });
});
