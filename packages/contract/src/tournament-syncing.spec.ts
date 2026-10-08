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

describe('TournamentSyncing', () => {
  it('missing은 소켓으로 안 나간다', () => {
    expect(TournamentSyncingSchema.parse({ syncing: true, present: 1, required: 2, missing: [] }))
      .toEqual({ syncing: true, present: 1, required: 2 });
  });
});
