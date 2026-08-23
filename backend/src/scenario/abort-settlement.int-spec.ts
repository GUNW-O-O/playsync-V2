import { PlayerStatus, TournamentStatus } from '@prisma/client';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **천재지변으로 대회를 중단한다.**
 *
 * 부품은 각각 검증돼 있다 — 금액 계산은 `settlement.spec.ts`가 순수 함수로,
 * 돈이 옮겨지는 것은 `session.service.int-spec.ts`가 심어 놓은 상태로 본다.
 * 여기서 보는 것은 **조립**이다. 실제로 앉고, 시작하고, 한 명이 탈락한 뒤에
 * 중단하면 장부가 맞아떨어지는가.
 *
 * 보존 등식이 이 시나리오의 전부다.
 *
 * ```
 * 걷은 참가비 == 이미 나간 상금 + 환불 + 상점 몫
 * ```
 *
 * 어긋나면 그 대회의 회계가 영영 안 맞는다. `completeSession`이 막으려던
 * 상태와 같은 모양이고, 취소(`cancelSession`)가 `totalBuyinAmount: 0`으로
 * 피하려던 것도 이것이다.
 */
describe('시나리오: 진행 중인 대회를 중단하면 장부가 맞아떨어진다', () => {
  let h: Harness;

  const PLAYERS = ['champ', 'runner', 'busted'];
  const POOL = SCENARIO.entryFee * PLAYERS.length;

  /** 중단 전에 각자가 들고 있던 포인트. 환불이 얼마나 늘렸는지 재는 기준이다. */
  const before = new Map<string, number>();
  let ownerBefore = 0;
  let result: { refunded: number; storeAmount: number; scaled: boolean };

  beforeAll(async () => {
    // 상금은 1위 몰아주기다. 그래야 중간 탈락자가 상금을 안 받아
    // **환불 규칙만** 이 시나리오의 변수로 남는다.
    h = await setupTournament(PLAYERS);

    // 한 명이 탈락한다. 3인 대회의 3위라 상금권 밖이고, 상금은 0이다.
    const seat = await h.prisma.tablePlayer.findFirstOrThrow({
      where: { tableId: h.tableId, userId: 'busted' },
    });
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    await h.playsync.eliminatePlayer(
      h.tournamentId, h.tableId,
      [{ id: 'busted', seatIndex: seat.seatPosition } as never],
      dashboard!,
    );

    for (const id of PLAYERS) {
      const user = await h.prisma.user.findUniqueOrThrow({ where: { id } });
      before.set(id, user.points);
    }
    const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: SCENARIO.owner } });
    ownerBefore = owner.points;

    result = await h.session.abortSession(h.tournamentId, SCENARIO.owner);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  async function gained(userId: string): Promise<number> {
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.points - (before.get(userId) ?? ownerBefore);
  }

  it('1. 살아 있던 둘은 낸 돈을 다 돌려받는다', async () => {
    expect(`champ +${await gained('champ')} / runner +${await gained('runner')}`)
      .toBe(`champ +${SCENARIO.entryFee} / runner +${SCENARIO.entryFee}`);
  });

  it('2. 탈락한 사람은 절반이다', async () => {
    expect(await gained('busted')).toBe(SCENARIO.entryFee / 2);
  });

  /** 걷은 3000 중 2500이 나갔다. 남은 500이 상점 주인에게 간다. */
  it('3. 남은 돈은 상점 주인에게 간다', async () => {
    const owner = await h.prisma.user.findUniqueOrThrow({ where: { id: SCENARIO.owner } });

    expect(`상점 +${owner.points - ownerBefore} / 결과 ${result.storeAmount}`)
      .toBe(`상점 +${SCENARIO.entryFee / 2} / 결과 ${SCENARIO.entryFee / 2}`);
  });

  /**
   * **이 대회에서 돈이 움직인 자리를 전부 더한다.** 참가비로 들어온 것과
   * 상금·환불·정산으로 나간 것이 같아야 한다.
   */
  it('4. 걷은 돈 == 상금 + 환불 + 상점 몫', async () => {
    const rows = await h.prisma.pointTransaction.findMany({
      where: { tournamentId: h.tournamentId },
      select: { type: true, amount: true },
    });
    const sum = (type: string) => rows
      .filter(r => r.type === type)
      .reduce((acc, r) => acc + r.amount, 0);

    // BUY_IN은 음수다(지갑에서 빠진다). 부호를 뒤집으면 걷은 총액이다.
    expect(`걷은 ${-sum('BUY_IN')} / 나간 ${sum('PRIZE') + sum('REFUND') + sum('SETTLEMENT')}`)
      .toBe(`걷은 ${POOL} / 나간 ${POOL}`);
  });

  it('5. 대회는 CANCELLED로 닫힌다', async () => {
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });

    expect(`${t.status} / 걷은 ${t.totalBuyinAmount} / 인원 ${t.activePlayers}`)
      .toBe(`${TournamentStatus.CANCELLED} / 걷은 0 / 인원 0`);
  });

  /**
   * **참가 행은 남는다.** 장부라서다 — 누가 참가했다가 중단으로 돌려받았는지가
   * 남아야 `PointTransaction`의 REFUND와 짝이 맞는다. 대회가 `CANCELLED`인
   * 것으로 "이 참가는 중단으로 끝났다"가 이미 표현된다.
   */
  it('6. 참가 기록은 지워지지 않는다', async () => {
    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
      select: { userId: true, status: true },
      orderBy: { userId: 'asc' },
    });

    expect(rows.map(r => `${r.userId}:${r.status}`).join(' '))
      .toBe(`busted:${PlayerStatus.ELIMINATED} champ:${PlayerStatus.PLAYING} runner:${PlayerStatus.PLAYING}`);
  });

  /** 테이블·딜러 세션·Redis가 함께 정리된다. 닫힌 대회에 붙을 자리가 없어야 한다. */
  it('7. 테이블과 딜러 세션과 Redis가 함께 정리된다', async () => {
    const tables = await h.prisma.table.count({ where: { tournamentId: h.tournamentId } });
    const dealer = await h.prisma.dealerSession.count({ where: { tournamentId: h.tournamentId } });
    const info = await h.redis.exists(`tournament:${h.tournamentId}:info`);
    const snapshot = await h.redis.exists(`table:state:${h.tableId}`);

    expect(`테이블 ${tables} / 딜러 ${dealer} / 전광판 ${info} / 스냅샷 ${snapshot}`)
      .toBe('테이블 0 / 딜러 0 / 전광판 0 / 스냅샷 0');
  });

  /**
   * **중단 뒤에 도착한 리바인은 돈을 빼가지 못한다**(T78).
   *
   * 리바인은 사람에게 15초를 묻고 오는 길이라 창이 넓다. 여기가 그 가드가
   * 실제로 필요한 자리다 — 중단이 그 창을 정상 경로로 만든다.
   */
  it('8. 중단 뒤에 도착한 리바인은 거절된다', async () => {
    const walletBefore = await h.prisma.user.findUniqueOrThrow({ where: { id: 'champ' } });

    await expect(
      h.playsync.executeRebuyTransaction(
        h.tournamentId, h.tableId, 'champ',
        SCENARIO.entryFee, SCENARIO.startStack, '시나리오 대회',
      ),
    ).rejects.toThrow();

    const walletAfter = await h.prisma.user.findUniqueOrThrow({ where: { id: 'champ' } });
    expect(walletAfter.points).toBe(walletBefore.points);
  });
});
