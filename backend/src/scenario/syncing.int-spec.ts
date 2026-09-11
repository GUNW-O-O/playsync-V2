import { ActionType } from 'src/game-engine/types';
import { checkInvariants, chipsOnTable, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T96 — 복구의 수명. `SYNCING`을 부팅이 켜고 딜러 태블릿의 n/n이 끈다.
 *
 * 부품은 각자 통합 스펙이 든다(`recovery.service.int-spec.ts`,
 * `redis.service.int-spec.ts`). 여기서 보는 것은 **조립**이다 — 부팅이
 * 켜는 자리와 `completeSync`가 끄는 자리가 같은 `pausedAt`을 주고받고, 그 사이
 * 몇 번을 다시 죽어도 보정이 끄는 자리에서 **한 번만** 일어나는가.
 *
 * 블라인드 구조는 1분짜리 레벨 둘, `rebuyUntil`은 2(두 번째 레벨에서 등록
 * 마감)다. 대회 시작 시각을 실제보다 훨씬 과거로 돌려 두면(`startedAt`),
 * "벽시계로는 이미 마감 레벨을 지났지만 `pausedAt`에 얼린 시각은 아직
 * 아니다"를 실제로 만들 수 있다 — 그래야 "얼렸다"가 "시간이 안 흘렀다"와
 * 구별된다.
 */
describe('시나리오 — SYNCING', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;
  const BLIND_STRUCTURE = [
    { lv: 1, sb: 100, ante: false, duration: 1 },
    { lv: 2, sb: 200, ante: false, duration: 1 },
  ];
  // 하트비트(정지 시작 시각)를 이 값만큼 과거로 찍는다.
  const HEARTBEAT_AGO_MS = 180_000;
  // 대회 시작을 이보다 더 과거로 돌려서, `pausedAt`에서 얼린 경과(50초)는
  // 마감 레벨(60초) 전이지만 벽시계 경과(230초)는 이미 마감 레벨(120초)을
  // 지나 있게 만든다.
  const STARTED_AT_AGO_MS = 230_000;

  afterAll(async () => { await h.close(); });

  async function setHeartbeatAgo(ms: number) {
    const beatAt = new Date(Date.now() - ms);
    await h.prisma.serverHeartbeat.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', beatAt },
      update: { beatAt },
    });
  }

  it('0. 판이 돈다', async () => {
    h = await setupTournament(PLAYERS, {
      blindStructure: BLIND_STRUCTURE,
      rebuyUntil: 2,
    });
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    await checkInvariants(h, '0. 프리플랍', chips);

    // 대회가 실제로는 훨씬 전에 시작한 것으로 되돌린다(하네스에
    // startedAtMsAgo 옵션이 없다).
    await h.prisma.tournament.update({
      where: { id: h.tournamentId },
      data: { startedAt: new Date(Date.now() - STARTED_AT_AGO_MS) },
    });
  });

  it('1. 하트비트가 3분 전 — recoverAll이 SYNCING을 켠다', async () => {
    await setHeartbeatAgo(HEARTBEAT_AGO_MS);

    await h.recovery.recoverAll();

    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`1. 상태 ${t.status}`).toBe('1. 상태 SYNCING');
    expect(t.pausedAt).not.toBeNull();
    expect(
      `1. pausedAt 오차 ${Math.abs(t.pausedAt!.getTime() - (Date.now() - HEARTBEAT_AGO_MS)) < 1000}`,
    ).toBe('1. pausedAt 오차 true');
    // 부팅은 밀지 않는다 — pausedMs는 누적된 적이 없으므로 그대로 0이다.
    expect(`1. pausedMs ${t.pausedMs}`).toBe('1. pausedMs 0');

    const blind = await h.redisService.getTournamentBlind(h.tournamentId);
    expect(`1. blindField.pausedAt ${blind!.pausedAt}`)
      .toBe(`1. blindField.pausedAt ${t.pausedAt!.getTime()}`);

    await checkInvariants(h, '1. SYNCING 진입', chips);
  });

  it('2. SYNCING 동안 레벨이 안 오르고 등록이 안 닫힌다', async () => {
    // 벽시계 기준이면 경과 230초 > 120초(두 레벨 합) — 이미 마감 레벨을 지나
    // 등록도 닫혀 있어야 한다. `pausedAt`에 얼린 경과는 50초 — 아직 첫 레벨
    // 안이라 등록이 열려 있어야 한다. 그 차이가 이 테스트의 요점이다.
    const synced = await h.redisService.checkAndSyncBlindLevel(h.tournamentId);
    expect(`2. 레벨 ${synced!.currentBlindLv}`).toBe('2. 레벨 0');

    const info = await h.redis.hget(`tournament:${h.tournamentId}:info`, 'isRegistrationOpen');
    expect(`2. 등록 ${info}`).toBe('2. 등록 1');

    await checkInvariants(h, '2. SYNCING 중', chips);
  });

  it('3. 복구 중 재시작 — pausedAt이 그대로고 대상에서 안 빠진다', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`3. 재시작 전 상태 ${before.status}`).toBe('3. 재시작 전 상태 SYNCING');

    await setHeartbeatAgo(90_000);
    await h.recovery.recoverAll();

    // 대상에서 빠지면(쿼리가 ONGOING만 본다) 아무 일도 안 해도 아래 pausedAt
    // 검사가 트리비얼하게 통과한다 — 실제로 다시 처리됐는지를 테이블 루프의
    // 부작용(턴 시계 재정지)으로 가른다. 1단계는 180초, 이번은 90초로 —
    // 대상에서 빠져 그대로면 180초 근방에 머문다.
    const table = await h.redisService.getSnapShot(h.tableId);
    const downMs = table!.resumePending!.downMs;
    expect(`3. downMs ${downMs > 85_000 && downMs < 110_000}`).toBe('3. downMs true');

    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`3. 상태 ${after.status}`).toBe('3. 상태 SYNCING');
    expect(`3. pausedAt 유지 ${after.pausedAt!.getTime() === before.pausedAt!.getTime()}`)
      .toBe('3. pausedAt 유지 true');

    await checkInvariants(h, '3. 복구 중 재시작', chips);
  });

  it('4. completeSync — SYNCING을 끝내고 한 번 보정한다', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    const blindBefore = (await h.redisService.getTournamentBlind(h.tournamentId))!;
    // 1단계 이후 pausedAt은 안 바뀌었다(3단계가 그것을 증명한다) — 여기서
    // 다시 읽는 것이 곧 그 첫 정지 시각이다.
    const pausedAtMs = before.pausedAt!.getTime();
    const callAt = Date.now();

    const result = await h.recovery.completeSync(h.tournamentId);
    expect(`4. 결과 ${result}`).toBe('4. 결과 true');

    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`4. 상태 ${after.status}`).toBe('4. 상태 ONGOING');
    expect(after.pausedAt).toBeNull();

    const blindAfter = (await h.redisService.getTournamentBlind(h.tournamentId))!;
    const deltaPausedMs = after.pausedMs - before.pausedMs;
    const deltaBlindStart = blindAfter.startedAt - blindBefore.startedAt;
    // DB와 Redis가 같은 Δ를 밀었는가.
    expect(Math.abs(deltaPausedMs - deltaBlindStart)).toBeLessThan(1000);
    // **Δ의 크기 자체가 실제 정지(1단계의 pausedAt부터 지금까지)와 같은가.**
    // 위 비교만으로는 둘 다 같은 상수만큼 어긋나도 못 잡는다 — 이 시나리오의
    // 핵심 주장(「한 번의 보정에 다 들어간다」)을 증명하는 것은 이 줄이다.
    expect(`4. Δ 크기 ${Math.abs(deltaPausedMs - (callAt - pausedAtMs)) < 1000}`)
      .toBe('4. Δ 크기 true');
    expect(blindAfter.pausedAt).toBeUndefined();

    await checkInvariants(h, '4. completeSync', chips);
  });

  it('5. 같은 대회에 completeSync 다시 — false, pausedMs 그대로', async () => {
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });

    const result = await h.recovery.completeSync(h.tournamentId);
    expect(`5. 결과 ${result}`).toBe('5. 결과 false');

    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`5. pausedMs ${after.pausedMs}`).toBe(`5. pausedMs ${before.pausedMs}`);

    await checkInvariants(h, '5. 이미 끝난 SYNCING', chips);
  });

  it('6. resumeTable — 액션이 다시 들어간다', async () => {
    await h.dealer.resumeTable(h.tableId);

    const state = await checkInvariants(h, '6. 재개', chips);
    const id = h.turnId(state)!;
    await h.playsync.handleAction(id, h.tableId, { action: ActionType.CALL } as never);

    await checkInvariants(h, `6. 콜 ${id}`, chips);
  });

  it('7. 동시 n/n — completeSync 두 번 동시 호출은 한 번만 이긴다', async () => {
    // 다시 SYNCING으로 만든다.
    await setHeartbeatAgo(20_000);
    await h.recovery.recoverAll();
    const before = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`7. 재진입 상태 ${before.status}`).toBe('7. 재진입 상태 SYNCING');
    const blindBefore = (await h.redisService.getTournamentBlind(h.tournamentId))!;

    const results = await Promise.all([
      h.recovery.completeSync(h.tournamentId),
      h.recovery.completeSync(h.tournamentId),
    ]);
    expect([...results].sort()).toEqual([false, true]);

    const after = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`7. 상태 ${after.status}`).toBe('7. 상태 ONGOING');
    const blindAfter = (await h.redisService.getTournamentBlind(h.tournamentId))!;
    const deltaPausedMs = after.pausedMs - before.pausedMs;
    const deltaBlindStart = blindAfter.startedAt - blindBefore.startedAt;
    // Δ 한 번만 — 두 호출이 겹쳐서 각자 밀면 이 값이 두 배 가까이 벌어진다.
    expect(Math.abs(deltaPausedMs - deltaBlindStart)).toBeLessThan(1000);

    await checkInvariants(h, '7. 동시 n/n', chips);
  });
});

/**
 * 앉은 사람이 아무도 없는 대회는 딜러 n/n을 기다릴 이유가 없다 — 접속할
 * 딜러가 없다. 위 describe와 나란히 세울 수 없다(하네스가 모듈 수준 핸들을
 * 쓴다 — `pause-resume.int-spec.ts`의 1-1 주석 참고). 그래서 별도 하네스로 돈다.
 */
describe('시나리오 — SYNCING (앉은 사람 없음)', () => {
  let h: Harness;

  afterAll(async () => { await h.close(); });

  it('좌석을 전부 비운 대회는 recoverAll 한 번으로 곧바로 ONGOING이다', async () => {
    h = await setupTournament(['p0', 'p1'], {
      blindStructure: [{ lv: 1, sb: 100, ante: false, duration: 1 }],
    });

    await h.session.releaseSeats(
      h.tournamentId, h.tableId,
      [{ seatIndex: 0, userId: 'p0' }, { seatIndex: 1, userId: 'p1' }],
      SCENARIO.owner,
    );
    // 해제 뒤 테이블 위에 남아야 할 칩 총량 — 아무도 없으므로 이 값이
    // 그대로 이 시나리오의 불변식 기준이다.
    const chips = chipsOnTable(await h.snapshot());

    await h.recovery.recoverAll();

    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`상태 ${t.status}`).toBe('상태 ONGOING');
    expect(t.pausedAt).toBeNull();

    await checkInvariants(h, '좌석 없는 대회 — recoverAll', chips);
  });
});
