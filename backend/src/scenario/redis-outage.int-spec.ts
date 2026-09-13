import { ActionType } from 'src/game-engine/types';
import { SERVER_RECOVERING_MESSAGE } from '@playsync/contract';
import { checkInvariants, Harness, setupTournament } from './harness';

/**
 * T97 — 백엔드는 살고 Redis만 죽었다 돌아온다.
 *
 * 부팅 복구는 안 돈다. 여기서 보는 것은 **런타임 복구의 조립**이다 — 끊긴 순간
 * DB가 대회를 켜고, 돌아온 순간 스윕이 테이블을 멈춰 세우고, 그 사이에 흘러든
 * 타임아웃이 사람을 폴드시키지 못하는가.
 *
 * 장애는 흉내 내지 않는다. 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다.
 */
describe('시나리오 — Redis만 죽는다', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;
  const HOLD_MS = 1500;

  afterAll(async () => { await h.close(); });

  async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('0. 판이 돈다 — 차례인 사람의 마감을 과거로 돌린다', async () => {
    h = await setupTournament(PLAYERS);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    const state = await h.snapshot();
    state.actionDeadline = Date.now() - 1000;
    await h.saveSnapshot(state);
    await checkInvariants(h, '0. 프리플랍', chips);
  });

  it('1~4. 끊긴 동안 DB가 켜고, 복구 스윕 전에 온 타임아웃은 폴드시키지 못한다', async () => {
    const before = await h.snapshot();
    const victim = h.turnId(before)!;
    const epoch = before.timerEpoch ?? 0;

    // 스윕을 붙잡아 둔다 — 복구 창에 타임아웃을 먼저 흘리기 위해서다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = h.recovery.recoverFromOutage.bind(h.recovery);
    const sweep = jest.spyOn(h.recovery, 'recoverFromOutage').mockImplementationOnce(async () => {
      await gate;
      await original();
    });

    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);

    // 1. 끊긴 순간
    await until(() => h.redisService.outage.phase === 'down');
    await until(async () =>
      (await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } })).status === 'SYNCING');
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`1. pausedAt ${t.pausedAt?.getTime() === h.redisService.outage.downSince}`).toBe('1. pausedAt true');

    // 2~3. 돌아왔지만 스윕 전 — 타임아웃 잡이 먼저 온다
    await until(() => h.redisService.outage.phase === 'recovering');
    await expect(
      h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch),
    ).rejects.toThrow(SERVER_RECOVERING_MESSAGE);
    const mid = await h.snapshot();
    expect(`3. ${victim} 폴드 ${mid.players[h.seatOf(mid, victim)]!.hasFolded}`).toBe(`3. ${victim} 폴드 false`);

    // 4. 스윕을 놓는다
    release();
    await until(() => h.redisService.outage.isUp());
    const after = await checkInvariants(h, '4. 스윕 뒤', chips);
    expect(`4. 세대 ${after.timerEpoch} 마감 ${after.actionDeadline} 정지 ${after.resumePending !== undefined}`)
      .toBe(`4. 세대 ${epoch + 1} 마감 undefined 정지 true`);

    // 낡은 세대의 타임아웃은 조용히 버려진다
    expect(await h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch)).toBeNull();
    sweep.mockRestore();
  });

  it('5. n/n — completeSync가 장애 시간만큼 한 번 민다', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    const pausedAt = before.pausedAt!.getTime();
    const callAt = Date.now();
    expect(await h.recovery.completeSync(h.tournamentId)).toBe(true);
    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`5. 상태 ${after.status}`).toBe('5. 상태 ONGOING');
    expect(`5. Δ ${Math.abs((after.pausedMs - before.pausedMs) - (callAt - pausedAt)) < 1000}`).toBe('5. Δ true');
  });

  it('6. 딜러 재개 → 차례인 사람의 액션이 들어간다', async () => {
    await h.dealer.resumeTable(h.tableId);
    const state = await checkInvariants(h, '6. 재개', chips);
    await h.playsync.handleAction(h.turnId(state)!, h.tableId, { action: ActionType.CALL } as never);
    await checkInvariants(h, '6. 콜', chips);
  });

  it('7. 끊기기 전에 나간 액션이 복구 뒤에 도착하면 거절된다 (락 안 가드)', async () => {
    const state = await h.snapshot();
    const actor = h.turnId(state)!;
    h.redis.options.retryStrategy = () => HOLD_MS;

    // 요청을 **락 안에서** 붙잡아 둔다 — 락은 잡았고 스냅샷은 아직 못 읽은 자리다.
    // 요청을 띄우고 곧바로 끊는 것으로는 순서가 서지 않는다: 끊기기 전에 커밋해
    // 버리거나, ioredis가 들고 있다 복구 뒤에 다시 보내 어느 쪽이든 초록이 된다.
    let entered!: () => void;
    const inLock = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = h.redisService.getSnapShot.bind(h.redisService);
    const read = jest.spyOn(h.redisService, 'getSnapShot').mockImplementationOnce(async (id) => {
      entered();
      await gate;
      return original(id);
    });

    const pending = h.playsync.handleAction(actor, h.tableId, { action: ActionType.CALL } as never);
    await inLock;
    h.redis.disconnect(true);
    // 돌아온 뒤, 스윕이 끝나기 전에 놓는다 — 스윕은 이 요청이 쥔 락을 기다리므로
    // 그보다 늦게 놓을 수 없다. 그래서 여기서 막는 것은 락 안 가드의 `isUp` 쪽이고,
    // 세대 비교만 따로 빨개지게 하는 입력은 없다.
    await until(() => h.redisService.outage.phase === 'recovering', 8000);
    release();
    await expect(pending).rejects.toMatchObject({ message: SERVER_RECOVERING_MESSAGE });
    read.mockRestore();

    await until(() => h.redisService.outage.isUp(), 8000);
    const after = await checkInvariants(h, '7. 복구 뒤', chips);
    expect(`7. ${actor} 베팅 그대로 ${after.players[h.seatOf(after, actor)]!.bet === state.players[h.seatOf(state, actor)]!.bet}`)
      .toBe(`7. ${actor} 베팅 그대로 true`);
  });
});

/** 차례가 없는 테이블에는 정지 표시가 안 붙는다 — 없으면 "전부 멈춘다"도 위를 통과한다. */
describe('시나리오 — Redis만 죽는다 (차례 없음)', () => {
  let h: Harness;
  afterAll(async () => { await h.close(); });

  it('WAITING 테이블은 복구 뒤에도 resumePending이 없다', async () => {
    h = await setupTournament(['p0', 'p1']);
    h.redis.options.retryStrategy = () => 500;
    h.redis.disconnect(true);
    const start = Date.now();
    while (!h.redisService.outage.isUp() || h.redisService.outage.generation === 0) {
      if (Date.now() - start > 8000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await h.snapshot()).resumePending).toBeUndefined();
  });
});
