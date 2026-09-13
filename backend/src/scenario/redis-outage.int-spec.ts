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
 * `retryStrategy`로 돌아올 시각을 쥔다. 순서가 필요한 자리는 타이밍을 기다리지
 * 않고 스파이로 한쪽을 붙잡아 강제한다.
 */
describe('시나리오 — Redis만 죽는다', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;
  const HOLD_MS = 1500;
  /** 첫 장애의 감지 시각. 복구 중 다시 끊겨도 보정은 여기서부터 한 번이다. */
  let firstDown: number;

  afterAll(async () => { await h.close(); });

  async function until(pred: () => boolean | Promise<boolean>, ms = 5000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function latch() {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    return { open, opened };
  }

  async function pausedAtOf() {
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    return t.pausedAt?.getTime() ?? null;
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
    const gate = latch();
    const original = h.recovery.recoverFromOutage.bind(h.recovery);
    const sweep = jest.spyOn(h.recovery, 'recoverFromOutage').mockImplementationOnce(async () => {
      await gate.opened;
      await original();
    });

    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);

    // 1. 끊긴 순간
    await until(() => h.redisService.outage.phase === 'down');
    await until(async () =>
      (await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } })).status === 'SYNCING');
    firstDown = h.redisService.outage.downSince!;
    expect(`1. pausedAt ${(await pausedAtOf()) === firstDown}`).toBe('1. pausedAt true');

    // 2~3. 돌아왔지만 스윕 전 — 타임아웃 잡이 먼저 온다
    await until(() => h.redisService.outage.phase === 'recovering');
    await expect(
      h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch),
    ).rejects.toThrow(SERVER_RECOVERING_MESSAGE);
    const mid = await h.snapshot();
    expect(`3. ${victim} 폴드 ${mid.players[h.seatOf(mid, victim)]!.hasFolded}`).toBe(`3. ${victim} 폴드 false`);

    // 4. 스윕을 놓는다
    gate.open();
    await until(() => h.redisService.outage.isUp());
    const after = await checkInvariants(h, '4. 스윕 뒤', chips);
    expect(`4. 세대 ${after.timerEpoch} 마감 ${after.actionDeadline} 정지 ${after.resumePending !== undefined}`)
      .toBe(`4. 세대 ${epoch + 1} 마감 undefined 정지 true`);

    // 낡은 세대의 타임아웃은 조용히 버려진다
    expect(await h.playsync.handleAction(victim, h.tableId, { action: ActionType.TIME_OUT } as never, epoch)).toBeNull();
    sweep.mockRestore();
  });

  it('5. 복구 중 한 번 더 끊긴다 — 낡은 스윕은 끝내지 않고, 멈춘 테이블을 다시 멈추지 않고, pausedAt은 첫 장애 것이다', async () => {
    // 대회는 아직 SYNCING(n/n 전)이고 테이블은 4에서 멈췄다.
    const epoch = (await h.snapshot()).timerEpoch;
    const outage = h.redisService.outage;

    // 스윕 A는 테이블을 다 본 뒤 끝내기 직전에, 스윕 B는 시작하자마자 붙잡는다.
    // B를 붙잡지 않으면 A를 놓는 순간 이미 up이라, A가 `markRecovered`를 불러도
    // no-op이어서 세대 검사를 지워도 초록이 된다.
    type Freeze = { freezeTournament(...args: unknown[]): Promise<unknown> };
    const recovery = h.recovery as unknown as Freeze;
    const original = recovery.freezeTournament.bind(h.recovery);
    const aFroze = latch();
    const aGate = latch();
    const bEntered = latch();
    const bGate = latch();
    const freeze = jest.spyOn(recovery, 'freezeTournament')
      .mockImplementationOnce(async (...args) => {
        const out = await original(...args);
        aFroze.open();
        await aGate.opened;
        return out;
      })
      .mockImplementationOnce(async (...args) => {
        bEntered.open();
        await bGate.opened;
        return original(...args);
      });
    const sweeps = jest.spyOn(h.recovery, 'recoverFromOutage');
    const recovered = jest.spyOn(outage, 'markRecovered');

    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);
    await aFroze.opened;
    const staleGeneration = outage.generation;

    // A가 쥔 채로 다시 끊는다
    h.redis.disconnect(true);
    await until(() => outage.generation === staleGeneration + 1);
    await bEntered.opened;

    aGate.open();
    await sweeps.mock.results[0]!.value;
    expect(`5. 낡은 스윕 뒤 ${outage.phase} markRecovered ${recovered.mock.calls.length}`)
      .toBe('5. 낡은 스윕 뒤 recovering markRecovered 0');

    bGate.open();
    await sweeps.mock.results[1]!.value;
    const after = await checkInvariants(h, '5. 두 번째 복구 뒤', chips);
    expect(`5. ${outage.phase} markRecovered ${recovered.mock.calls.length} 세대 ${after.timerEpoch} 정지 ${after.resumePending !== undefined}`)
      .toBe(`5. up markRecovered 1 세대 ${epoch} 정지 true`);
    expect(`5. pausedAt 첫 장애 ${(await pausedAtOf()) === firstDown}`).toBe('5. pausedAt 첫 장애 true');

    freeze.mockRestore();
    sweeps.mockRestore();
    recovered.mockRestore();
  });

  it('6. n/n — completeSync가 첫 장애부터 한 번 민다', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    const callAt = Date.now();
    expect(await h.recovery.completeSync(h.tournamentId)).toBe(true);
    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`6. 상태 ${after.status}`).toBe('6. 상태 ONGOING');
    expect(`6. Δ ${Math.abs((after.pausedMs - before.pausedMs) - (callAt - firstDown)) < 1000}`).toBe('6. Δ true');
  });

  it('7. 딜러 재개 → 차례인 사람의 액션이 들어간다', async () => {
    await h.dealer.resumeTable(h.tableId);
    const state = await checkInvariants(h, '7. 재개', chips);
    await h.playsync.handleAction(h.turnId(state)!, h.tableId, { action: ActionType.CALL } as never);
    await checkInvariants(h, '7. 콜', chips);
  });

  it('8. 락을 쥔 채 끊긴 액션은 복구 중에 거절된다 (락 안 가드 — up 검사)', async () => {
    const state = await h.snapshot();
    const actor = h.turnId(state)!;
    h.redis.options.retryStrategy = () => HOLD_MS;

    // 요청을 **락 안에서** 붙잡아 둔다 — 락은 잡았고 스냅샷은 아직 못 읽은 자리다.
    // 요청을 띄우고 곧바로 끊는 것으로는 순서가 서지 않는다: 끊기기 전에 커밋해
    // 버리거나, ioredis가 들고 있다 복구 뒤에 다시 보내 어느 쪽이든 초록이 된다.
    const entered = latch();
    const gate = latch();
    const original = h.redisService.getSnapShot.bind(h.redisService);
    const read = jest.spyOn(h.redisService, 'getSnapShot').mockImplementationOnce(async (id) => {
      entered.open();
      await gate.opened;
      return original(id);
    });

    const pending = h.playsync.handleAction(actor, h.tableId, { action: ActionType.CALL } as never);
    await entered.opened;
    h.redis.disconnect(true);
    // 돌아온 뒤, 스윕이 끝나기 전에 놓는다 — 스윕은 이 요청이 쥔 락을 기다리므로
    // 그보다 늦게 놓을 수 없다. 그래서 여기서 막는 것은 락 안 가드의 up 검사다.
    // 세대 비교는 요청을 락 **앞에서** 붙잡는 9가 본다.
    await until(() => h.redisService.outage.phase === 'recovering', 8000);
    gate.open();
    await expect(pending).rejects.toMatchObject({ message: SERVER_RECOVERING_MESSAGE });
    read.mockRestore();

    await until(() => h.redisService.outage.isUp(), 8000);
    const after = await checkInvariants(h, '8. 복구 뒤', chips);
    expect(`8. ${actor} 베팅 그대로 ${after.players[h.seatOf(after, actor)]!.bet === state.players[h.seatOf(state, actor)]!.bet}`)
      .toBe(`8. ${actor} 베팅 그대로 true`);
  });

  it('9. 락을 기다리던 액션이 복구가 끝난 뒤 락을 얻으면 거절된다 (락 안 가드 — 세대 검사)', async () => {
    // 8의 스윕이 테이블을 다시 멈췄다. n/n과 딜러 재개로 판을 다시 연다.
    expect(await h.recovery.completeSync(h.tournamentId)).toBe(true);
    await h.dealer.resumeTable(h.tableId);
    const state = await checkInvariants(h, '9. 재개', chips);
    const actor = h.turnId(state)!;
    h.redis.options.retryStrategy = () => HOLD_MS;

    // 락 **앞에서** 붙잡는다. 프로덕션에서는 `withTableLock`이 SET NX를 최대 5초
    // 재시도하는 동안이다. 락이 비어 있으니 스윕은 테이블을 멈추고 끝까지 돈다 —
    // 놓는 순간 up이고 세대만 다르다. 세대 검사가 없으면 요청은 `resumePending`
    // 검사에 걸려 **다른 문구**로 거절되므로 문구까지 본다.
    const entered = latch();
    const gate = latch();
    const original = h.redisService.withTableLock.bind(h.redisService);
    const lock = jest.spyOn(h.redisService, 'withTableLock').mockImplementationOnce(async (...args) => {
      entered.open();
      await gate.opened;
      return original(...args);
    });

    const pending = h.playsync.handleAction(actor, h.tableId, { action: ActionType.CALL } as never);
    await entered.opened;
    const generation = h.redisService.outage.generation;
    h.redis.disconnect(true);
    // `reconnecting`은 소켓이 닫힌 뒤에 오므로 끊은 직후엔 아직 up이다 — 세대로 기다린다.
    await until(() => h.redisService.outage.generation === generation + 1 && h.redisService.outage.isUp(), 8000);
    expect(`9. 스윕이 멈췄다 ${(await h.snapshot()).resumePending !== undefined}`).toBe('9. 스윕이 멈췄다 true');

    gate.open();
    await expect(pending).rejects.toMatchObject({ message: SERVER_RECOVERING_MESSAGE });
    lock.mockRestore();

    const after = await checkInvariants(h, '9. 복구 뒤', chips);
    expect(`9. ${actor} 베팅 그대로 ${after.players[h.seatOf(after, actor)]!.bet === state.players[h.seatOf(state, actor)]!.bet}`)
      .toBe(`9. ${actor} 베팅 그대로 true`);
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
