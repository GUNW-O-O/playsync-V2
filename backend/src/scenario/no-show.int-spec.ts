import { PlayerStatus } from '@prisma/client';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **노쇼 — 돈은 냈는데 끝내 안 온 사람.**
 *
 * `Tournament.activePlayers`가 **결제에서 늘고 착석 기반 탈락에서 줄었다.**
 * 세는 집합과 빼는 집합이 달라서, 한 명이라도 안 오면 카운터가 영영 실제보다
 * 크게 남는다. 그러면 최후 1인 판정(`activePlayerCount <= 1`)이 걸리지 않아
 * **우승 상금이 자동으로 나가지 않고** 상점이 손으로 닫아야 한다.
 *
 * T55의 방침: `activePlayers`가 세는 것은 **지금 대회에 살아 있는 사람**이다.
 * 결제한 사람 수가 필요하면 그건 이미 따로 있다 — `totalPlayers`와
 * `totalBuyinAmount`가 바이인의 횟수와 금액을 든다. 두 축을 한 카운터에 섞고
 * 있던 것이 이 결함의 실체다.
 *
 * 그래서 카운터는 **첫 착석**(`WAITING` → `PLAYING`)에서 오르고 탈락에서
 * 내린다. 노쇼는 앉은 적이 없으니 애초에 세지 않는다. 그 사람의 참가비는
 * 프라이즈풀에 남고 상금은 못 받는데, 그것이 결함이 아니라 **노쇼의 정의**다.
 */
describe('시나리오: 노쇼가 있어도 대회가 스스로 닫힌다', () => {
  let h: Harness;

  /** 착석 둘 + 결제만 한 하나. */
  const SEATED = ['champ', 'loser'];
  const NO_SHOW = 'noshow';

  beforeAll(async () => {
    h = await setupTournament(SEATED);

    // 노쇼는 결제까지만 한다. 좌석 태블릿 앞에 오지 않은 사람이다.
    await h.prisma.user.create({
      data: { id: NO_SHOW, nickname: NO_SHOW, password: 'x', points: SCENARIO.initialPoints },
    });
    await h.payment.joinSession({ tournamentId: h.tournamentId }, NO_SHOW);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('1. 결제는 인원수를 올리지 않는다 — 올리는 것은 착석이다', async () => {
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });

    // 셋이 결제했고 둘이 앉았다. 바이인 쪽 축은 셋을 그대로 든다.
    expect(`앉은 ${t.activePlayers} / 결제 ${t.totalPlayers} / 걷은 ${t.totalBuyinAmount}`)
      .toBe(`앉은 2 / 결제 3 / 걷은 ${3 * SCENARIO.entryFee}`);
  });

  it('2. 전광판이 읽는 Redis 카운터도 같은 값이다', async () => {
    // DB만 고치면 전광판이 다른 수를 띄운다. 최후 1인 판정도 이쪽을 본다.
    const active = Number(await h.redis.hget(`tournament:${h.tournamentId}:info`, 'activePlayer'));

    expect(`전광판 ${active}명`).toBe('전광판 2명');
  });

  it('3. 노쇼는 WAITING에 머문다 — 앉은 적이 없다', async () => {
    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
      select: { userId: true, status: true },
      orderBy: { userId: 'asc' },
    });

    expect(rows).toEqual([
      { userId: 'champ', status: PlayerStatus.PLAYING },
      { userId: 'loser', status: PlayerStatus.PLAYING },
      { userId: NO_SHOW, status: PlayerStatus.WAITING },
    ]);
  });

  it('4. 앉은 사람이 하나 남으면 자동으로 우승 상금이 나간다', async () => {
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    const seat = await h.prisma.tablePlayer.findFirstOrThrow({
      where: { tableId: h.tableId, userId: 'loser' },
    });

    // 엔진의 `TablePlayer`는 `id`가 **userId**다(좌석 행의 기본키가 아니다).
    await h.playsync.eliminatePlayer(
      h.tournamentId, h.tableId,
      [{ id: 'loser', seatIndex: seat.seatPosition } as never],
      dashboard!,
    );

    // 노쇼가 카운터에 섞여 있으면 여기서 2로 남아 최후 1인 판정이 안 걸린다.
    const champ = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'champ' },
    });
    expect(`${champ.status} ${champ.finalPlace}위 ${champ.prizeAmount}원`)
      .toBe(`AWARDED 1위 ${3 * SCENARIO.entryFee}원`);
  });

  it('5. 노쇼의 참가비는 프라이즈풀에 남고 상금은 0이다', async () => {
    const row = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: NO_SHOW },
    });

    // 안 온 사람의 돈이 우승자에게 갔다. 이것이 노쇼의 정의다.
    expect(`${row.status} 상금 ${row.prizeAmount}`).toBe('WAITING 상금 0');
  });

  it('6. 정산 게이트가 닫힌다 — 걷은 것과 나간 것이 같다', async () => {
    // 노쇼가 있어도 `걷은 것 == 상금`이 성립해야 상점이 대회를 닫을 수 있다.
    await expect(h.session.completeSession(h.tournamentId)).resolves.not.toThrow();

    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`대회 ${t.status}`).toBe('대회 FINISHED');
  });
});
