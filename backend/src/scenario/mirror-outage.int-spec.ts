import { PlayerStatus } from '@prisma/client';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * T105 — Redis가 죽은 동안 참가하고, 돌아오면 미러가 따라붙는다.
 *
 * **스텁은 없다.** 장애는 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다(T97 · T100 · T103 시나리오와 같다).
 * 오프라인 큐도 함께 꺼서 **재시도 예산을 다 쓴 최종 상태**를 짧은 무대에
 * 세운다 — 큐를 그대로 두면 명령이 재접속까지 앉았다 성공해 「거절되는 자리」가
 * 서지 않는다.
 *
 * **단위·통합의 `phase` 플래그로는 이 무대가 안 선다.** 그쪽은 진짜 Redis가
 * 살아 있어서 **커밋 전의 읽기가 전부 성공한다** — 그래서 어느 경로가 실제로
 * 커밋까지 가고 어느 경로가 그 전에 거절되는지를 통째로 가린다. 이 시나리오의
 * 값이 정확히 그 구분이다.
 *
 * | 경로 | 커밋 전에 Redis를 읽나 | 장애 중 결과 |
 * |---|---|---|
 * | 시작 **전** 대회 참가 | **안 읽는다** — `isRegistrationOpenLive`가 `startedAt`이 없으면 컬럼만 본다 | 커밋된다. 미러는 복구 뒤 |
 * | 시작한 대회 참가 | 읽는다(`getTournamentDashboard`) | 커밋 전에 거절. **돈이 안 빠진다** |
 * | 착석 | 읽는다(`getSnapShot`) | 커밋 전에 거절 |
 *
 * 즉 `mirrorAfterCommit`이 **실제로 무는 자리는 첫 줄 하나**다. 나머지 둘의
 * 미러 처리는 「장애가 읽기 뒤 · 미러 앞에 시작하는」 좁은 창을 위한 것이고,
 * 그 창은 이 무대로 재지 않는다(재려면 쓰기 한복판에서 끊어야 한다).
 */
describe('시나리오 — Redis가 죽은 동안 참가한다', () => {
  const HOLD_MS = 1500;
  const LATECOMER = 'latecomer';

  async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function outage(h: Harness) { return h.redisService.outage; }
  async function dropFor(h: Harness) {
    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.options.enableOfflineQueue = false;
    h.redis.disconnect(true);
    await until(() => outage(h).phase === 'down');
  }

  let h: Harness;
  /** 아직 시작하지 않은 대회. 하네스의 것은 `setupTournament`가 시작시킨다. */
  let pendingId: string;
  let pendingTableId: string;

  beforeAll(async () => {
    h = await setupTournament(['a', 'b'], { registrationOpen: true });

    // **상점이 대회를 하나 더 연다.** 제품 경로 그대로다(`createSession`).
    await h.session.createSession({
      name: '시작 전 대회',
      type: 'TOURNAMENT',
      storeId: SCENARIO.store,
      startStack: SCENARIO.startStack,
      entryFee: SCENARIO.entryFee,
      rebuyUntil: 5,
      payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
      rakePercent: 0,
      isRegistrationOpen: true,
      blindId: SCENARIO.blind,
    } as never, SCENARIO.owner);

    const pending = await h.prisma.tournament.findFirstOrThrow({
      where: { name: '시작 전 대회' },
    });
    pendingId = pending.id;
    pendingTableId = (await h.prisma.table.findFirstOrThrow({
      where: { tournamentId: pendingId },
    })).id;

    await h.prisma.user.create({
      data: { id: LATECOMER, nickname: LATECOMER, password: 'x', points: SCENARIO.initialPoints },
    });
  });

  /**
   * **무대를 반드시 되돌린다.** 검사가 일찍 실패하면 오프라인 큐가 꺼진 채로
   * teardown이 돌고, 끊긴 클라이언트의 `quit()`이 매달린다 — 빨간불이 아니라
   * 정지가 되어 원인을 못 읽는다(실제로 그렇게 멎었다). 복구까지 기다려
   * 정상 클라이언트로 내린다.
   */
  afterAll(async () => {
    h.redis.options.enableOfflineQueue = true;
    if (!outage(h).isUp()) {
      await until(() => outage(h).isUp(), 15000).catch(() => { /* 그래도 내린다 */ });
    }
    await h.close();
  });

  it('1~5. 끊긴 동안 참가는 커밋되고 미러만 밀리며, 착석은 커밋 전에 거절된다', async () => {
    const infoKey = `tournament:${pendingId}:info`;

    // 1. 끊는다.
    await dropFor(h);
    expect(outage(h).phase).toBe('down');

    // 2. **시작 전 대회 참가는 커밋까지 간다.** 이 경로는 커밋 전에 Redis를
    //    한 번도 안 읽는다 — 그래서 장애가 통째로 걸쳐도 돈이 움직인다.
    //    예전에는 그 뒤 `joinPlayer`가 던져 503이 나갔고, 참가자는 **돈이 빠진
    //    채 실패 화면**을 봤다.
    await h.payment.joinSession({ tournamentId: pendingId }, LATECOMER);

    const joined = await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: pendingId, userId: LATECOMER } },
    });
    const paid = await h.prisma.user.findUniqueOrThrow({ where: { id: LATECOMER } });
    const row = await h.prisma.tournament.findUniqueOrThrow({ where: { id: pendingId } });
    expect(`상태 ${joined.status} 포인트 ${paid.points} DB엔트리 ${row.totalPlayers} DB걷은돈 ${row.totalBuyinAmount}`)
      .toBe(`상태 ${PlayerStatus.WAITING} 포인트 ${SCENARIO.initialPoints - SCENARIO.entryFee} DB엔트리 1 DB걷은돈 ${SCENARIO.entryFee}`);

    // 3. **반대 입력 — 착석은 커밋 전에 거절된다.** `getSnapShot`이 미러보다
    //    앞에 있어 장애가 통째로 걸치면 여기까지 오지 못한다. 미러 규칙이
    //    닫는 것은 「읽기 뒤 · 미러 앞」의 좁은 창이지 장애 전체가 아니다.
    await expect(h.entry.enterSeat(pendingId, {
      otp: (await h.prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: pendingId, userId: LATECOMER } },
        omit: { playerOtp: false },
      })).playerOtp,
      tableId: pendingTableId,
      seatIndex: 0,
    })).rejects.toThrow();

    // 4. 돌아온다. 복구 스윕이 `markRecovered`를 부르고, 그때 미룬 미러가 깨어난다.
    h.redis.options.enableOfflineQueue = true;
    await until(() => outage(h).isUp());

    // 5. 미러가 따라붙었다. 전광판이 읽는 값이 DB와 같아졌다.
    await until(async () => (await h.redis.hget(infoKey, 'totalPlayer')) !== null);
    const info = await h.redis.hgetall(infoKey);
    expect(`엔트리 ${info.totalPlayer} 걷은돈 ${info.totalBuyinAmount}`)
      .toBe(`엔트리 1 걷은돈 ${SCENARIO.entryFee}`);
  });
});
