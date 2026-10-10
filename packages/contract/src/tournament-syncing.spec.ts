import { SyncStatusSchema, TournamentSyncingSchema } from './tournament-syncing';

describe('SyncStatus', () => {
  it('안 돌아온 자리를 싣고 딜러는 seatIndex null이다', () => {
    const parsed = SyncStatusSchema.parse({
      syncing: true, present: 3, required: 5, extra: 1,
      missing: [{ tableId: 't1', seatIndex: null }, { tableId: 't1', seatIndex: 4, nickname: 'x' }],
    });
    expect(parsed).toEqual({
      syncing: true, present: 3, required: 5,
      missing: [{ tableId: 't1', seatIndex: null }, { tableId: 't1', seatIndex: 4 }],
    });
  });
  it('missing이 없으면 거부한다', () => {
    expect(SyncStatusSchema.safeParse({ syncing: false, present: 0, required: 0 }).success).toBe(false);
  });
});

describe('멈춘 원인 (T121)', () => {
  it('회선 끊김은 딜러 띠와 상점 상태에 실린다', () => {
    expect(TournamentSyncingSchema.parse({ syncing: true, present: 0, required: 2, reason: 'lineDown' }).reason)
      .toBe('lineDown');
    expect(SyncStatusSchema.parse({ syncing: true, present: 0, required: 2, missing: [], reason: 'lineDown' }).reason)
      .toBe('lineDown');
  });
  it('없으면 서버 장애다 — 키 자체가 없다', () => {
    expect(TournamentSyncingSchema.parse({ syncing: true, present: 0, required: 2 })).not.toHaveProperty('reason');
  });
  it('모르는 원인은 거부한다', () => {
    expect(TournamentSyncingSchema.safeParse({ syncing: true, present: 0, required: 2, reason: 'other' }).success).toBe(false);
    expect(SyncStatusSchema.safeParse({ syncing: true, present: 0, required: 2, missing: [], reason: 'other' }).success).toBe(false);
  });
});

describe('TournamentSyncing', () => {
  it('missing은 소켓으로 안 나간다', () => {
    expect(TournamentSyncingSchema.parse({ syncing: true, present: 1, required: 2, missing: [] }))
      .toEqual({ syncing: true, present: 1, required: 2 });
  });
});
