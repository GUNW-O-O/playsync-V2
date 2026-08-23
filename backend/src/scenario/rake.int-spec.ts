import { TournamentStatus } from '@prisma/client';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **상점 몫(레이크)이 붙은 대회 하나를 끝까지 돌린다.**
 *
 * 계산은 `prize.spec.ts`가 순수 함수로 보고, 게이트 산수는
 * `session.service.spec.ts`가 목으로 본다. 여기서 보는 것은 **조립**이다 —
 * 전광판이 띄우는 프라이즈풀과 실제로 나가는 상금과 게이트가 요구하는 합,
 * 셋이 같은 풀을 보는가.
 *
 * 셋이 갈라지면 증상이 조용하다. 상금은 프라이즈풀만큼 나가는데 게이트가 걷은
 * 총액을 요구하면 **대회가 영영 안 닫히고**, 전광판만 걷은 총액을 띄우면
 * 참가자가 받을 수 없는 금액을 본다.
 *
 * 보존 등식은 하나다.
 *
 * ```
 * 걷은 참가비 == 나간 상금 + 상점 몫
 * ```
 */
describe('시나리오: 상점 몫이 붙은 대회가 장부대로 닫힌다', () => {
  let h: Harness;

  const PLAYERS = ['champ', 'second', 'third'];
  const RAKE_PERCENT = 10;
  const POOL = SCENARIO.entryFee * PLAYERS.length;
  const RAKE = Math.floor((POOL * RAKE_PERCENT) / 100);
  const PRIZE_POOL = POOL - RAKE;

  let ownerBefore = 0;

  beforeAll(async () => {
    // 1위 몰아주기라 프라이즈풀 전액이 우승자에게 간다 — 분배 규칙이 아니라
    // **풀의 크기**를 재는 시나리오다.
    h = await setupTournament(PLAYERS, { rakePercent: RAKE_PERCENT });

    const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: SCENARIO.owner } });
    ownerBefore = owner.points;
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** 걷은 돈은 레이크와 무관하게 참가비 그대로다. 레이크는 나갈 때 뗀다. */
  it('1. 걷은 총액은 참가비 그대로다 — 입장에서는 아무것도 안 뗀다', async () => {
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    const store = await h.prisma.pointTransaction.count({ where: { type: 'SETTLEMENT' } });

    expect(`걷은 ${t.totalBuyinAmount} / 상점 내역 ${store}건`)
      .toBe(`걷은 ${POOL} / 상점 내역 0건`);
  });

  /**
   * **전광판이 띄우는 프라이즈풀은 상점 몫을 뺀 값이다.** 걷은 총액을 띄우면
   * 참가자가 받을 수 없는 금액을 보게 된다.
   */
  it('2. 전광판의 프라이즈풀은 상점 몫을 뺀 값이다', async () => {
    const info = await h.redisService.getFullTournamentInfo(h.tournamentId);

    expect(`풀 ${info!.dashboard.prizePool} / 걷은 ${info!.dashboard.totalBuyinAmount}`)
      .toBe(`풀 ${PRIZE_POOL} / 걷은 ${POOL}`);
  });

  it('3. 전광판의 1위 상금도 그 풀에서 나온다', async () => {
    const info = await h.redisService.getFullTournamentInfo(h.tournamentId);

    expect(info!.dashboard.prizes.find(p => p.place === 1)!.amount).toBe(PRIZE_POOL);
  });

  /**
   * 둘을 탈락시키면 최후 1인 판정이 걸려 우승 상금이 자동으로 나간다.
   * **그 금액이 전광판과 같아야 한다.**
   */
  it('4. 우승 상금이 프라이즈풀만큼 나간다 — 걷은 총액이 아니다', async () => {
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    for (const loser of ['third', 'second']) {
      const seat = await h.prisma.tablePlayer.findFirstOrThrow({
        where: { tableId: h.tableId, userId: loser },
      });
      await h.playsync.eliminatePlayer(
        h.tournamentId, h.tableId,
        [{ id: loser, seatIndex: seat.seatPosition } as never],
        dashboard!,
      );
    }

    const champ = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'champ' },
    });
    expect(`${champ.status} ${champ.finalPlace}위 ${champ.prizeAmount}원`)
      .toBe(`AWARDED 1위 ${PRIZE_POOL}원`);
  });

  /**
   * **게이트가 상금만 봤으면 여기서 막혔다.** 걷은 총액과 나간 상금이 상점
   * 몫만큼 벌어져 있어, 그 차이를 「남은 돈」으로 읽으면 대회가 안 닫힌다.
   */
  it('5. 정산이 끝난 것으로 보고 대회가 닫힌다', async () => {
    await h.session.completeSession(h.tournamentId, SCENARIO.owner);

    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(t.status).toBe(TournamentStatus.FINISHED);
  });

  it('6. 상점 몫이 주인에게 간다', async () => {
    const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: SCENARIO.owner } });
    const row = await h.prisma.pointTransaction.findFirst({
      where: { userId: SCENARIO.owner, tournamentId: h.tournamentId, type: 'SETTLEMENT' },
    });

    expect(`상점 +${owner.points - ownerBefore} / 내역 ${row === null ? '없음' : row.amount}`)
      .toBe(`상점 +${RAKE} / 내역 ${RAKE}`);
  });

  /** 이 대회에서 돈이 움직인 자리를 전부 더한다. */
  it('7. 걷은 돈 == 나간 상금 + 상점 몫', async () => {
    const rows = await h.prisma.pointTransaction.findMany({
      where: { tournamentId: h.tournamentId },
      select: { type: true, amount: true },
    });
    const sum = (type: string) => rows
      .filter(r => r.type === type)
      .reduce((acc, r) => acc + r.amount, 0);

    // BUY_IN은 음수다(지갑에서 빠진다). 부호를 뒤집으면 걷은 총액이다.
    expect(`걷은 ${-sum('BUY_IN')} / 나간 ${sum('PRIZE') + sum('SETTLEMENT')}`)
      .toBe(`걷은 ${POOL} / 나간 ${POOL}`);
  });
});
