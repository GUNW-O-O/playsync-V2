import { CLOSED_TOURNAMENT_WRITE } from 'src/store/session/tournament-status';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **닫힌 대회에는 아무것도 쓰지 않는다.**
 *
 * `FINISHED`·`CANCELLED`가 되면 그 대회는 회계가 끝난 것이다
 * (`CLOSED_TOURNAMENT_STATUSES`). 그런데 상태를 보는 자리와 쓰는 자리가
 * 갈라져 있는 곳이 넷 있었다 — **검사는 트랜잭션 밖, 쓰기는 안**이라
 * 그 사이에 대회가 닫히면 쓰기가 그대로 통과한다.
 *
 * | | 자리 | 새는 것 |
 * |---|---|---|
 * | A | `PlaysyncService.executeRebuyTransaction` | 참가비 차감 · `totalBuyinAmount` · `buyInCount` |
 * | B | `PlaysyncService.eliminatePlayer` | 상금 지급 · `activePlayers` |
 * | C | `PaymentService.joinSession` | 참가비 · 참가 행 · `totalPlayers` |
 * | D | `DealerService.handleDealerAction`의 KICK | `activePlayers` · 참가 `ELIMINATED` |
 *
 * A의 창이 제일 넓다. 리바인은 **사람에게 15초를 묻고** 오는 길이라, 묻는
 * 동안 대회가 닫히는 것이 드문 일이 아니다. 그리고 돈만 빠진다 — 칩을 넣는
 * `mutateSnapshot`은 지워진 스냅샷을 못 찾아 아무 일도 안 하므로, 장부
 * 검산(`걷은 참가비 == 나간 상금`)은 이미 통과한 뒤에 어긋난다.
 *
 * C는 여기 없다. **경합이라 늦은 도착으로는 재현되지 않아서** — 트랜잭션
 * 한가운데서 대회가 닫히는 순간을 만들어야 하고, 그건 스텁이 허용되는
 * `payment.service.int-spec.ts`의 몫이다(이 계층은 스텁을 두지 않는다).
 *
 * 여기서는 `status`를 직접 닫는다. **누가 닫았는지는 규칙과 무관하다** —
 * `completeSession`이든 `cancelSession`이든 닫힌 뒤에 온 쓰기를 막는 것이
 * 검증 대상이고, 지금 `cancelSession`은 시작한 대회를 거절하므로(②가 걷어낸다)
 * 그 경로로는 이 상태를 만들 수도 없다.
 */
describe('시나리오: 닫힌 대회에는 아무것도 쓰지 않는다', () => {
  let h: Harness;

  const PLAYERS = ['alice', 'bob', 'carol'];
  let infoKey: string;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
    infoKey = `tournament:${h.tournamentId}:info`;

    // **핸드가 도는 도중에 닫힌다.** 늦게 도착하는 호출을 흉내 내려면 판이
    // 살아 있어야 한다 — 프리플랍을 안 열면 딜러 킥이 엔진의 「액션할 수 있는
    // 상태가 아닙니다」에 먼저 걸려, 가드를 지워도 테스트가 초록이다.
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    // 대회를 닫는다. 닫는 쪽은 Redis도 함께 비우므로(`deleteTournament`)
    // 전광판 키가 없는 상태가 곧 닫힌 뒤의 세계다.
    await h.prisma.tournament.update({
      where: { id: h.tournamentId },
      data: { status: 'CANCELLED' },
    });
    await h.redis.del(infoKey);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** 대회의 장부 세 축과 그 사람의 지갑을 한 줄로 굳힌다. */
  async function ledgerOf(userId: string): Promise<string> {
    const t = await h.prisma.tournament.findUniqueOrThrow({
      where: { id: h.tournamentId },
    });
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const part = await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId } },
    });
    return [
      `걷은 ${t.totalBuyinAmount}`,
      `인원 ${t.activePlayers}`,
      `지갑 ${user.points}`,
      `바이인 ${part.buyInCount}회`,
      `상태 ${part.status}`,
      `상금 ${part.prizeAmount}`,
    ].join(' / ');
  }

  /**
   * **A — 리바인.** 15초를 묻고 돌아온 길이라 창이 제일 넓다.
   *
   * 막지 않으면 참가비가 지갑에서 빠지고 `totalBuyinAmount`가 늘어난다.
   * 칩은 안 들어온다(스냅샷이 없다) — 돈만 사라지는 모양이다.
   */
  it('A. 리바인이 늦게 도착해도 참가비가 빠지지 않는다', async () => {
    const before = await ledgerOf('alice');

    await expect(
      h.playsync.executeRebuyTransaction(
        h.tournamentId, h.tableId, 'alice',
        SCENARIO.entryFee, SCENARIO.startStack, '시나리오 대회',
      ),
    ).rejects.toThrow(CLOSED_TOURNAMENT_WRITE);

    expect(await ledgerOf('alice')).toBe(before);
  });

  /**
   * **지운 전광판 키가 되살아나지 않는다.**
   *
   * `RedisService.rebuyPlayer`의 `hincrby`는 **없는 키를 만든다.** 닫으면서
   * 지운 `tournament:{id}:info`가 필드 하나짜리로 부활하고, 그 키에는 TTL이
   * 없어 그대로 남는다. 트랜잭션이 먼저 거절해야 이 호출까지 안 간다.
   */
  it('A-2. 지운 전광판 키가 되살아나지 않는다', async () => {
    expect(await h.redis.exists(infoKey)).toBe(0);
  });

  /**
   * **B — 탈락.** 둘을 한꺼번에 파산시켜 최후 1인이 되게 한다. 막지 않으면
   * `tournamentFinished`가 걸려 **닫힌 대회에서 우승 상금이 나간다.**
   */
  it('B. 탈락이 늦게 도착해도 상금이 나가지 않는다', async () => {
    const before = await Promise.all(PLAYERS.map(ledgerOf));

    const seats = await h.prisma.tablePlayer.findMany({
      where: { tableId: h.tableId, userId: { in: ['bob', 'carol'] } },
    });
    const busted = seats.map(s => ({ id: s.userId, seatIndex: s.seatPosition } as never));

    await expect(
      h.playsync.eliminatePlayer(h.tournamentId, h.tableId, busted, {
        entryFee: SCENARIO.entryFee,
        startStack: SCENARIO.startStack,
        tournamentName: '시나리오 대회',
      } as never),
    ).rejects.toThrow(CLOSED_TOURNAMENT_WRITE);

    expect(await Promise.all(PLAYERS.map(ledgerOf))).toEqual(before);
  });

  /** 좌석 행도 함께 되돌아온다 — 삭제가 탈락보다 앞에 있다. */
  it('B-2. 좌석 행이 지워지지 않는다', async () => {
    const seated = await h.prisma.tablePlayer.count({ where: { tableId: h.tableId } });

    expect(`앉은 ${seated}명`).toBe(`앉은 ${PLAYERS.length}명`);
  });

  /**
   * **D — 딜러 킥.** 파이널 테이블 게이트(T77)는 이 상황을 막지 않는다 —
   * 그건 등록 마감과 테이블 수를 보지 대회가 닫혔는지는 안 본다.
   *
   * **문구까지 단언한다.** 안 하면 엔진의 「액션할 수 있는 상태가 아닙니다」로도
   * 초록이 되어, 가드를 통째로 지워도 이 검사가 안 터진다 — 실제로 그렇게
   * 지나간 판이 있었다.
   */
  it('D. 딜러 킥이 늦게 도착해도 인원이 줄지 않는다', async () => {
    const before = await ledgerOf('carol');

    await expect(
      h.dealer.handleDealerAction(h.tournamentId, h.tableId, 'carol', 'KICK'),
    ).rejects.toThrow('이미 닫힌 대회입니다.');

    expect(await ledgerOf('carol')).toBe(before);
  });
});
