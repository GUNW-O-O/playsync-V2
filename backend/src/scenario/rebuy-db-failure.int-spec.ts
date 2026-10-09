import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T118 — 리바인을 수락한 순간 **DB가 잠깐 못 받는다.**
 *
 * 스텁은 없다. 일시 실패는 pg 풀을 실제로 다 쥐어서 만든다 — 열 개의 트랜잭션이
 * 연결을 하나씩 잡고 문 앞에서 기다리면, 리바인 트랜잭션은 연결을 못 얻어
 * Prisma가 「Unable to start a transaction in the given time」(P2028)을 던진다.
 * 1,000테이블 kill 실측에서 549건이 난 바로 그 오류다.
 *
 * 그때는 그것이 거절로 세어져 382명이 탈락했다. 수락한 사람의 탈락을 풀 부족이
 * 정하면 안 된다 — 다시 시도하고, 끝내 안 되면 딜러의 재개 뒤에 다시 묻는다.
 */
describe('시나리오 — 리바인을 수락한 순간 DB가 잠깐 못 받는다', () => {
  const PLAYERS = ['a', 'b', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, b: 1000, winner: 10000 };
  /** pg `Pool`의 기본 상한. 제품(`PrismaService`)도 기본값을 쓴다. */
  const POOL_SIZE = 10;

  let h: Harness;
  const prompts: { userId: string }[] = [];

  async function until(pred: () => boolean | Promise<boolean>, ms = 12000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const pointsOf = async (id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;
  const statusOf = async (id: string) =>
    (await h.prisma.tournamentParticipation.findFirstOrThrow({ where: { tournamentId: h.tournamentId, userId: id } })).status;

  /** 풀을 전부 쥔다. 돌려받은 함수를 부르면 놓는다. */
  async function exhaustPool() {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let held = 0;
    const holders = Array.from({ length: POOL_SIZE }, () =>
      h.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        held++;
        await gate;
      }, { timeout: 30000, maxWait: 10000 }),
    );
    await until(() => held === POOL_SIZE);
    return async () => { open(); await Promise.all(holders); };
  }

  /** a와 b가 올인으로 파산하는 쇼다운까지 몬다. 돌려주는 값은 그때의 칩 총량이다. */
  async function bustAandB() {
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
    return STACKS.a + STACKS.b + STACKS.winner;
  }

  describe('연결을 끝내 못 얻는다', () => {
  beforeAll(async () => {
    process.env.REBUY_TIMEOUT_MS = '60000';
    // 시도마다 연결을 1초 기다리고 두 번 시도한다 — 제품 기본값(5초 · 4번)으로는
    // 이 검사가 20초를 넘긴다.
    process.env.DB_SYNC_RETRY_ATTEMPTS = '2';
    process.env.DB_TX_MAX_WAIT_MS = '1000';
    prompts.length = 0;
    h = await setupTournament(PLAYERS, { registrationOpen: true });
    h.emitter.on('rebuy.request.sent', (p: { userId: string }) => { prompts.push(p); });
  });
  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    delete process.env.DB_SYNC_RETRY_ATTEMPTS;
    delete process.env.DB_TX_MAX_WAIT_MS;
    await h.close();
  });

  it('1~4. 탈락시키지 않고 재개 대기로 두고, 딜러가 재개하면 다시 물어 한 번만 반영한다', async () => {
    let chips = await bustAandB();
    await checkInvariants(h, '1. 쇼다운', chips);
    const aPoints = await pointsOf('a');

    const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);
    await until(() => prompts.some(p => p.userId === 'a') && prompts.some(p => p.userId === 'b'));
    h.emitter.emit('rebuy_res_b', false);

    // 2. 풀을 다 쥔 채로 a가 수락한다 — 재시도가 끝나도 탈락이 아니라 재개 대기다
    const release = await exhaustPool();
    let paused;
    try {
      h.emitter.emit('rebuy_res_a', true);
      await until(async () => (await h.snapshot()).resumePending !== undefined);
      paused = await h.snapshot();
    } finally {
      await release();
    }
    await checkInvariants(h, '2. 재개 대기', chips);
    expect(`2. 사유 ${paused.resumePending?.reason} 리바인표시 ${paused.rebuyPending === undefined} a스택 ${paused.players[h.seatOf(paused, 'a')]!.stack} a포인트 ${await pointsOf('a') === aPoints} a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf('a')}`)
      .toBe('2. 사유 transientError 리바인표시 true a스택 0 a포인트 true a묻기 1 a상태 PLAYING');

    // 3. 딜러가 재개한다 — a에게만 다시 묻는다
    h.emitter.once('rebuy.request.sent', ({ userId }: { userId: string }) => {
      setImmediate(() => h.emitter.emit(`rebuy_res_${userId}`, true));
    });
    await h.dealer.resumeTable(h.tableId);
    await settling;
    expect(`3. a묻기 ${prompts.filter(p => p.userId === 'a').length} b묻기 ${prompts.filter(p => p.userId === 'b').length}`)
      .toBe('3. a묻기 2 b묻기 1');

    // 4. a는 한 번 반영되고 한 번 빠졌다. b는 거절했으니 탈락이다.
    chips += SCENARIO.startStack;
    const after = await checkInvariants(h, '4. 재개 뒤 수락', chips);
    expect(`4. a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf('a'))} b상태 ${await statusOf('b')}`)
      .toBe(`4. a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} b상태 ELIMINATED`);
  });
  });

  /**
   * T120 — **잠깐 못 얻는 것은 기다렸다가 받는다.** `SYNCING`이 풀리는 순간 전 테이블이
   * 한꺼번에 움직여 풀이 10~15초 물린다(667테이블 kill 실측). Prisma의 기본값은 연결을
   * 2초만 기다리고 던져서, 재시도 넷을 다 쓰고도 리바인 200~300건이 미뤄졌다.
   *
   * 재시도를 끈다(시도 1번). 그래야 「2초에 던지고 다시 해서 성공」과 「기다렸다가
   * 성공」이 갈린다 — 재시도가 있으면 예전 값으로도 초록이다.
   */
  describe('연결을 3초 뒤에 얻는다', () => {
    beforeAll(async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      process.env.DB_SYNC_RETRY_ATTEMPTS = '1';
      prompts.length = 0;
      h = await setupTournament(PLAYERS, { registrationOpen: true });
      h.emitter.on('rebuy.request.sent', (p: { userId: string }) => { prompts.push(p); });
    });
    afterAll(async () => {
      delete process.env.REBUY_TIMEOUT_MS;
      delete process.env.DB_SYNC_RETRY_ATTEMPTS;
      await h.close();
    });

    it('5. 미루지 않고 기다렸다가 그 한 번에 반영한다', async () => {
      const chips = await bustAandB();
      const aPoints = await pointsOf('a');
      const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);
      await until(() => prompts.some(p => p.userId === 'a') && prompts.some(p => p.userId === 'b'));
      h.emitter.emit('rebuy_res_b', false);

      const release = await exhaustPool();
      h.emitter.emit('rebuy_res_a', true);
      await new Promise((r) => setTimeout(r, 3000));
      await release();
      await settling;

      const after = await checkInvariants(h, '5. 기다렸다 반영', chips + SCENARIO.startStack);
      expect(`5. 재개대기 ${after.resumePending !== undefined} a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf('a'))} a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf('a')}`)
        .toBe(`5. 재개대기 false a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} a묻기 1 a상태 PLAYING`);
    });
  });
});
