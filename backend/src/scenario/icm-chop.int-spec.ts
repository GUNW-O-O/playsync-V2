import { TournamentStatus } from '@prisma/client';
import { Harness, SCENARIO, setupTournament } from './harness';

/**
 * **파이널 테이블에서 딜로 끝낸다.**
 *
 * 실제 대회의 흔한 마무리다 — 남은 둘셋이 지쳐서 최후 1인까지 안 가고 남은
 * 상금을 칩 비율로 나눈다. 그 경로가 없으면 딜로 끝난 대회는 시스템이 닫지
 * 못했다: `completeSession`의 게이트가 「걷은 것 == 나간 상금 + 상점 몫」인데
 * 딜은 그 합을 만드는 길이 없었다.
 *
 * 계산은 `settlement.spec.ts`가, 문을 여는 조건은
 * `session.service.int-spec.ts`가 본다. 여기서 보는 것은 **조립**이다 —
 * 진짜로 대회를 돌려 파이널 테이블을 만들고, 딜로 닫고, 장부가 맞는가.
 */
describe('시나리오: 파이널 테이블에서 딜로 끝낸다', () => {
  let h: Harness;

  const PLAYERS = ['champ', 'runner', 'busted'];
  const POOL = SCENARIO.entryFee * PLAYERS.length;

  /** 딜 직전에 각자가 들고 있던 포인트. 상금이 얼마나 들어왔는지 재는 기준이다. */
  const before = new Map<string, number>();

  beforeAll(async () => {
    // 상금권 셋. 3위가 먼저 받고 나가야 「이미 나간 상금을 뺀다」가 재현된다.
    h = await setupTournament(PLAYERS, {
      prizePayouts: [
        { place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 },
      ],
    });

    // 한 명이 탈락해 3위 상금을 받는다. 남은 둘이 파이널 테이블이다.
    const seat = await h.prisma.tablePlayer.findFirstOrThrow({
      where: { tableId: h.tableId, userId: 'busted' },
    });
    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    await h.playsync.eliminatePlayer(
      h.tournamentId, h.tableId,
      [{ id: 'busted', seatIndex: seat.seatPosition } as never],
      dashboard!,
    );

    // 칩을 3:1로 갈라 둔다. 딜의 결과가 비율을 따르는지 보려면 둘이 달라야 한다.
    await h.prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'champ' } },
      data: { currentStack: 22_500 },
    });
    await h.prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'runner' } },
      data: { currentStack: 7_500 },
    });

    // 등록을 닫는다. 파이널 테이블의 조건 하나다(테이블은 원래 하나).
    //
    // **두 곳을 함께 닫는다.** 마감을 읽는 경로(`isRegistrationOpenLive`)가
    // Redis를 먼저 보므로 DB 컬럼만 바꾸면 전광판이 아직 열려 있다고 답한다 —
    // 실제로는 레벨이 `rebuyUntil`을 지나면서 둘이 함께 닫힌다.
    await h.prisma.tournament.update({
      where: { id: h.tournamentId },
      data: { isRegistrationOpen: false },
    });
    await h.redis.hset(`tournament:${h.tournamentId}:info`, 'isRegistrationOpen', '0');

    for (const id of PLAYERS) {
      const user = await h.prisma.user.findUniqueOrThrow({ where: { id } });
      before.set(id, user.points);
    }
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  async function gained(userId: string): Promise<number> {
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.points - (before.get(userId) ?? 0);
  }

  /**
   * **미리보기가 실제 거절과 같은 문장을 쓴다.**
   *
   * 콘솔은 못 누르는 버튼을 숨기지 않고 이유를 그 자리에 적는데, 그 문장을
   * 화면이 따로 지으면 서버가 실제로 거절하는 조건과 갈라진다 — 「닫을 수
   * 있다」고 그려 놓고 누르면 409가 나는 화면이다. 여기서 **두 경로를 실제로
   * 부딪쳐** 같은 문자열인지 본다. 문구를 복사한 단언은 두 벌을 증명하지
   * 못한다.
   */
  it('0-a. 종료를 막는 이유가 실제 거절 문장과 같다', async () => {
    const preview = await h.session.getFinishPreview(h.tournamentId, SCENARIO.owner);

    const thrown = await h.session
      .completeSession(h.tournamentId, SCENARIO.owner)
      .then(() => null)
      .catch((e: Error) => e.message);

    expect(`${preview.complete.canRun} / ${preview.complete.reason}`)
      .toBe(`false / ${thrown}`);
  });

  /**
   * 미리보기의 금액이 **실제 지급과 같은 계산**에서 나온다. 여기서는 그것이
   * 장부와 맞는지만 본다 — 아래 2번이 실제로 나간 돈을 재고, 그 둘이 같아야
   * 미리보기가 그림이 아니라 예고가 된다.
   */
  it('0-b. 딜 미리보기가 남은 상금을 전부 나눈다', async () => {
    const preview = await h.session.getFinishPreview(h.tournamentId, SCENARIO.owner);
    const sum = preview.chop.rows.reduce((acc, r) => acc + r.amount, 0);

    expect(`딜 ${preview.chop.canRun} / 나눔 ${sum} / 남은 ${preview.remainingPrize}`)
      .toBe(`딜 true / 나눔 2400 / 남은 2400`);
  });

  it('1. 딜이 대회를 닫는다', async () => {
    await h.session.chopSession(h.tournamentId, SCENARIO.owner);

    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(t.status).toBe(TournamentStatus.FINISHED);
  });

  /**
   * 3위가 이미 20%(600)를 받아 갔다. 남은 2400을 칩 비율 3:1로 나눈다.
   * **분배율(50/30)이 아니라 칩 비율(75/25)이 이긴다** — 딜이 상금 구조를
   * 대체한다.
   */
  it('2. 남은 상금이 칩 비율대로 갈린다 — 분배율이 아니다', async () => {
    expect(`champ +${await gained('champ')} / runner +${await gained('runner')}`)
      .toBe('champ +1800 / runner +600');
  });

  it('3. 이미 나간 상금은 다시 나누지 않는다', async () => {
    // 3위는 딜 전에 받았고 딜에서는 아무것도 안 받는다.
    expect(await gained('busted')).toBe(0);
  });

  it('4. 등수와 상금이 참가 행에 남는다', async () => {
    const rows = await h.prisma.tournamentParticipation.findMany({
      where: { tournamentId: h.tournamentId },
      orderBy: { finalPlace: 'asc' },
    });

    expect(rows.map(r => `${r.finalPlace}위 ${r.userId} ${r.prizeAmount}`).join(' / '))
      .toBe('1위 champ 1800 / 2위 runner 600 / 3위 busted 600');
  });

  /** 걷은 돈과 나간 상금이 맞아떨어진다. 게이트가 그것을 보고 열렸다. */
  it('5. 걷은 돈 == 나간 상금', async () => {
    const rows = await h.prisma.pointTransaction.findMany({
      where: { tournamentId: h.tournamentId },
      select: { type: true, amount: true },
    });
    const sum = (type: string) => rows
      .filter(r => r.type === type)
      .reduce((acc, r) => acc + r.amount, 0);

    expect(`걷은 ${-sum('BUY_IN')} / 나간 ${sum('PRIZE')}`)
      .toBe(`걷은 ${POOL} / 나간 ${POOL}`);
  });

  it('6. 테이블과 딜러 세션과 Redis가 함께 정리된다', async () => {
    const tables = await h.prisma.table.count({ where: { tournamentId: h.tournamentId } });
    const dealer = await h.prisma.dealerSession.count({ where: { tournamentId: h.tournamentId } });
    const info = await h.redis.exists(`tournament:${h.tournamentId}:info`);

    expect(`테이블 ${tables} / 딜러 ${dealer} / 전광판 ${info}`).toBe('테이블 0 / 딜러 0 / 전광판 0');
  });
});
