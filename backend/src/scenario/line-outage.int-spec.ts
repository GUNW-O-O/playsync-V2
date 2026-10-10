import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T121 — 리바인을 묻는 중에 대회장의 회선이 끊긴다.
 *
 * 서버도 Redis도 멀쩡하다. 그래서 Redis 장애의 세대(`RedisOutage.generation`)는 안
 * 오르고, 그대로 두면 서버 타이머가 마감을 채워 끊긴 태블릿의 파산자를 탈락시킨다.
 *
 * 「딜러 소켓이 전부 끊겼다」의 판정은 게이트웨이의 일이라 하네스에 없다 —
 * `pauseForLineOutage`를 직접 불러 대신한다(`rebuy-outage`가 `completeSync`를 직접
 * 부르는 것과 같다).
 */
describe('시나리오 — 리바인 창에 회선이 끊긴다', () => {
  const PLAYERS = ['a', 'b', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, b: 1000, winner: 10000 };

  async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const pointsOf = async (h: Harness, id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;
  const statusOf = async (h: Harness, id: string) =>
    (await h.prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId: h.tournamentId, userId: id } })).status;

  async function bustAandB(h: Harness) {
    const state = await h.snapshot();
    for (const p of state.players) if (p) p.stack = STACKS[p.id];
    await h.saveSnapshot(state);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    for (let guard = 0; guard < 20; guard++) {
      const s = await h.snapshot();
      if (s.phase === GamePhase.SHOWDOWN) break;
      const id = h.turnId(s);
      if (!id) break;
      const me = s.players[h.seatOf(s, id)]!;
      const target = Math.min(me.stack + me.bet, 1000);
      const action = target > s.currentBet ? ActionType.RAISE : ActionType.CALL;
      await h.playsync.handleAction(id, h.tableId,
        { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never);
    }
  }

  let h: Harness;
  let chips = STACKS.a + STACKS.b + STACKS.winner;
  const prompts: { userId: string; deadline: number }[] = [];

  beforeAll(async () => {
    // 짧게 둔다 — 대기를 안 끊는 구현은 이 마감에 a를 탈락시키고 정산을 끝낸다.
    process.env.REBUY_TIMEOUT_MS = '3000';
    h = await setupTournament(PLAYERS, { registrationOpen: true });
    h.emitter.on('rebuy.request.sent', (p: { userId: string; deadline: number }) => { prompts.push(p); });
  });
  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    h.redisService.linePause.clearAll();
    await h.close();
  });

  it('1~5. 묻던 자리는 탈락하지 않고, 딜러가 재개해야 다시 묻는다', async () => {
    await bustAandB(h);
    await checkInvariants(h, '1. 쇼다운', chips);
    const aPoints = await pointsOf(h, 'a');

    let settled = false;
    const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]).finally(() => { settled = true; });

    // 1. 둘에게 묻고, b는 회선이 살아 있을 때 거절한다
    await until(() => prompts.some(p => p.userId === 'a') && prompts.some(p => p.userId === 'b'));
    h.emitter.emit('rebuy_res_b', false);
    const firstDeadline = prompts.find(p => p.userId === 'a')!.deadline;

    // 2. 회선이 끊겼다 — 그 대회의 딜러가 전부 사라졌다
    expect(`2. 멈췄다 ${await h.recovery.pauseForLineOutage(h.tournamentId, new Date())}`).toBe('2. 멈췄다 true');

    // 3. a의 대기는 마감을 채우지 않고 끝나, 테이블이 딜러의 재개를 기다린다.
    //    정산이 먼저 끝났다면 대기가 안 끊긴 것이다 — 그 경우 아래가 탈락을 보여 준다.
    await until(async () => settled || (await h.snapshot()).resumePending !== undefined);
    const paused = await checkInvariants(h, '3. 재개 대기', chips);
    expect(`3. 사유 ${paused.resumePending?.reason} 리바인표시 ${paused.rebuyPending === undefined} a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf(h, 'a')} a포인트 ${await pointsOf(h, 'a') === aPoints}`)
      .toBe('3. 사유 lineDown 리바인표시 true a묻기 1 a상태 PLAYING a포인트 true');

    // 4. n/n(하네스는 직접) → 재개 → a에게만 새 마감으로 묻는다
    await h.recovery.completeSync(h.tournamentId);
    h.emitter.once('rebuy.request.sent', ({ userId }: { userId: string }) => {
      setImmediate(() => h.emitter.emit(`rebuy_res_${userId}`, true));
    });
    await h.dealer.resumeTable(h.tableId);
    await settling;

    const aPrompts = prompts.filter(p => p.userId === 'a');
    expect(`4. a묻기 ${aPrompts.length} 새마감 ${aPrompts[1]?.deadline !== firstDeadline} b묻기 ${prompts.filter(p => p.userId === 'b').length}`)
      .toBe('4. a묻기 2 새마감 true b묻기 1');

    // 5. a는 한 번 반영되고 한 번 빠졌다. b는 거절했으니 탈락이다.
    chips += SCENARIO.startStack;
    const after = await checkInvariants(h, '5. 재개 뒤 수락', chips);
    expect(`5. a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))} b상태 ${await statusOf(h, 'b')}`)
      .toBe(`5. a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} b상태 ELIMINATED`);
  });
});
