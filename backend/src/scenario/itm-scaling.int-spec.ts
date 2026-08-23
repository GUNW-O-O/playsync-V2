import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **참가 규모가 상금권 인원을 정한다.**
 *
 * 계산은 `payout-table.spec.ts`가 순수 함수로 다 본다. 여기서 보는 것은
 * **조립**이다 — 사람이 결제하고 리바인하는 동안 전광판의 상금권과 상금
 * 목록이 따라 움직이는가, 그리고 실제 지급이 그 목록과 같은가.
 *
 * **분모는 사람 수가 아니라 엔트리 수다.** 리바인이 사람을 안 늘리고 엔트리를
 * 늘리므로, 두 값이 갈리는 구간을 일부러 만든다 — 그래야 어느 쪽을 보는지가
 * 증명된다. `totalPlayer`를 보면 상금권이 안 늘고, `entryCount`를 보면 는다.
 */
describe('시나리오: 엔트리가 늘면 상금권도 는다', () => {
  let h: Harness;

  /** 착석하는 사람. 리바인으로 엔트리를 더 만든다. */
  const SEATED = ['a', 'b', 'c', 'd', 'e', 'f'];

  /**
   * 경계가 6과 10인 표. 기본표와 같은 모양이되 이 시나리오가 넘나드는 구간만
   * 남겼다 — 표 전체를 쓰면 어느 경계를 넘었는지가 실패 메시지에서 안 읽힌다.
   */
  const TABLE = [
    { minEntries: 0, payouts: [{ place: 1, percent: 100 }] },
    { minEntries: 6, payouts: [{ place: 1, percent: 65 }, { place: 2, percent: 35 }] },
    {
      minEntries: 10,
      payouts: [
        { place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 },
      ],
    },
  ];

  async function board() {
    const info = await h.redisService.getFullTournamentInfo(h.tournamentId);
    return info!.dashboard;
  }

  /** 리바인 한 번. 대회 장부와 전광판을 함께 올린다 — 결제와 같은 축이다. */
  async function rebuy(userId: string) {
    await h.playsync.executeRebuyTransaction(
      h.tournamentId, h.tableId, userId,
      SCENARIO.entryFee, SCENARIO.startStack, '시나리오 대회',
    );
  }

  beforeAll(async () => {
    h = await setupTournament(SEATED, { payoutTable: TABLE });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('1. 여섯이 앉으면 상금권이 둘이다', async () => {
    const d = await board();

    expect(`엔트리 ${d.entryCount} / 상금권 ${d.itmCount}명`).toBe('엔트리 6 / 상금권 2명');
  });

  /** 목록과 인원이 같은 자리에서 나온다 — 둘이 어긋나면 화면이 스스로 모순된다. */
  it('2. 상금 목록의 길이가 곧 상금권 인원이다', async () => {
    const d = await board();

    expect(d.prizes.length).toBe(d.itmCount);
  });

  /**
   * **리바인 넷으로 엔트리가 10이 된다.** 사람은 여전히 여섯이다 —
   * `totalPlayer`를 보는 구현이었다면 여기서 상금권이 안 늘어난다.
   */
  it('3. 리바인으로 엔트리가 늘면 상금권이 는다 — 사람 수는 그대로다', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await rebuy(id);

    const d = await board();
    expect(`사람 ${d.totalPlayer} / 엔트리 ${d.entryCount} / 상금권 ${d.itmCount}명`)
      .toBe('사람 6 / 엔트리 10 / 상금권 3명');
  });

  /** 프라이즈풀도 같은 분모로 커진다. 둘이 같은 값에서 나와야 어긋나지 않는다. */
  it('4. 프라이즈풀도 엔트리를 따라 커진다', async () => {
    const d = await board();

    expect(d.prizePool).toBe(SCENARIO.entryFee * 10);
  });

  it('5. 늘어난 상금권의 금액이 프라이즈풀과 정확히 같다', async () => {
    const d = await board();
    const sum = d.prizes.reduce((acc, p) => acc + p.amount, 0);

    expect(`${d.prizes.map(p => p.amount).join('+')} = ${sum}`)
      .toBe(`5000+3000+2000 = ${d.prizePool}`);
  });

  /**
   * **지급이 전광판과 같은 표를 본다.** 4위로 탈락하면 상금권 밖이고,
   * 3위로 탈락하면 그 구간의 몫을 받는다 — 엔트리가 6이던 시절의 표(상금권
   * 둘)를 쓰고 있었다면 3위도 0원이다.
   */
  it('6. 3위 탈락이 실제로 상금을 받는다', async () => {
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);

    // 넷을 차례로 떨어뜨려 3위까지 만든다.
    for (const loser of ['f', 'e', 'd', 'c']) {
      const seat = await h.prisma.tablePlayer.findFirstOrThrow({
        where: { tableId: h.tableId, userId: loser },
      });
      await h.playsync.eliminatePlayer(
        h.tournamentId, h.tableId,
        [{ id: loser, seatIndex: seat.seatPosition } as never],
        dashboard!,
      );
    }

    const third = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'c' },
    });
    const fourth = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'd' },
    });

    expect(`3위 ${third.prizeAmount}원 / 4위 ${fourth.prizeAmount}원`)
      .toBe('3위 2000원 / 4위 0원');
  });

  /** 마지막 한 명이 남으면 최후 1인 판정이 걸려 1·2위가 함께 확정된다. */
  it('7. 대회가 끝나면 1·2위도 그 표대로 받는다', async () => {
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    const seat = await h.prisma.tablePlayer.findFirstOrThrow({
      where: { tableId: h.tableId, userId: 'b' },
    });
    await h.playsync.eliminatePlayer(
      h.tournamentId, h.tableId,
      [{ id: 'b', seatIndex: seat.seatPosition } as never],
      dashboard!,
    );

    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId, userId: { in: ['a', 'b'] } },
      orderBy: { userId: 'asc' },
    });

    expect(rows.map(r => `${r.userId} ${r.finalPlace}위 ${r.prizeAmount}원`).join(' / '))
      .toBe('a 1위 5000원 / b 2위 3000원');
  });

  /** 걷은 돈과 나간 상금이 맞아떨어진다. 상금권이 늘어도 합은 그대로다. */
  it('8. 나간 상금 합이 프라이즈풀과 같다', async () => {
    const rows = await h.prisma.pointTransaction.findMany({
      where: { tournamentId: h.tournamentId },
      select: { type: true, amount: true },
    });
    const sum = (type: string) => rows
      .filter(r => r.type === type)
      .reduce((acc, r) => acc + r.amount, 0);

    // BUY_IN·REBUY는 음수다(지갑에서 빠진다). 부호를 뒤집으면 걷은 총액이다.
    expect(`걷은 ${-(sum('BUY_IN') + sum('REBUY'))} / 나간 ${sum('PRIZE')}`)
      .toBe(`걷은 ${SCENARIO.entryFee * 10} / 나간 ${SCENARIO.entryFee * 10}`);
  });
});
