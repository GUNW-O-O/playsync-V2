import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T100 — 리바인 창에 Redis만 죽었다 돌아온다.
 *
 * 스텁은 없다. 장애는 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다(T97 시나리오와 같다). 딜러의 n/n은
 * 게이트웨이의 일이라 하네스에 없다 — `completeSync`를 직접 불러 대신한다.
 *
 * 단계마다 칩 총량과 포인트를 본다. 리바인은 칩이 정당하게 느는 유일한 경로라
 * 반영된 순간에만 기대값을 올린다.
 */
describe('시나리오 — 리바인 창에 Redis가 죽는다', () => {
  const PLAYERS = ['a', 'b', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, b: 1000, winner: 10000 };
  const HOLD_MS = 1500;

  async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  function latch() {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    return { open, opened };
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

  function outage(h: Harness) { return h.redisService.outage; }
  async function dropFor(h: Harness) {
    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.disconnect(true);
    await until(() => outage(h).phase === 'down');
  }

  describe('창이 열린 채 끊긴다', () => {
    let h: Harness;
    let chips = STACKS.a + STACKS.b + STACKS.winner;
    const prompts: { userId: string; deadline: number }[] = [];

    beforeAll(async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      h = await setupTournament(PLAYERS, { registrationOpen: true });
      h.emitter.on('rebuy.request.sent', (p: { userId: string; deadline: number }) => { prompts.push(p); });
    });
    afterAll(async () => {
      delete process.env.REBUY_TIMEOUT_MS;
      await h.close();
    });

    it('1~6. 장애 중엔 아무것도 확정하지 않고, 딜러가 재개해야 다시 묻는다', async () => {
      await bustAandB(h);
      await checkInvariants(h, '1. 쇼다운', chips);
      const aPoints = await pointsOf(h, 'a');

      const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);

      // 1~2. 둘에게 묻고, b는 up일 때 거절한다
      await until(() => prompts.filter(p => p.userId === 'a').length === 1 && prompts.some(p => p.userId === 'b'));
      h.emitter.emit('rebuy_res_b', false);
      const firstDeadline = prompts.find(p => p.userId === 'a')!.deadline;

      // 3. 끊는다 — a의 대기는 마감(60초)을 기다리지 않고 끝난다
      await dropFor(h);
      await until(() => outage(h).isUp());   // 복구 스윕이 markRecovered

      // 4. 돌아왔다 — 재개 대기가 서고, 다시 묻지 않는다
      await until(async () => (await h.snapshot()).resumePending !== undefined);
      const paused = await checkInvariants(h, '4. 재개 대기', chips);
      expect(`4. 리바인표시 ${paused.rebuyPending === undefined} a스택 ${paused.players[h.seatOf(paused, 'a')]!.stack} a포인트 ${await pointsOf(h, 'a') === aPoints} a묻기 ${prompts.filter(p => p.userId === 'a').length} a상태 ${await statusOf(h, 'a')}`)
        .toBe('4. 리바인표시 true a스택 0 a포인트 true a묻기 1 a상태 PLAYING');

      // 5. n/n(하네스는 직접) → 재개 → a에게만 새 마감으로 묻는다
      await h.recovery.completeSync(h.tournamentId);
      h.emitter.once('rebuy.request.sent', ({ userId }: { userId: string }) => {
        setImmediate(() => h.emitter.emit(`rebuy_res_${userId}`, true));
      });
      await h.dealer.resumeTable(h.tableId);
      await settling;

      const aPrompts = prompts.filter(p => p.userId === 'a');
      expect(`5. a묻기 ${aPrompts.length} 새마감 ${aPrompts[1]!.deadline !== firstDeadline} b묻기 ${prompts.filter(p => p.userId === 'b').length}`)
        .toBe('5. a묻기 2 새마감 true b묻기 1');

      // 6. a는 한 번 반영되고 한 번 빠졌다. b는 탈락했다.
      chips += SCENARIO.startStack;
      const after = await checkInvariants(h, '6. 재개 뒤 수락', chips);
      expect(`6. a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))} b상태 ${await statusOf(h, 'b')}`)
        .toBe(`6. a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee} b상태 ELIMINATED`);
    });
  });

  describe('수락이 락 안에 들어간 뒤 끊긴다', () => {
    let h: Harness;
    let chips = STACKS.a + STACKS.b + STACKS.winner;

    beforeAll(async () => {
      process.env.REBUY_TIMEOUT_MS = '60000';
      h = await setupTournament(PLAYERS, { registrationOpen: true });
    });
    afterAll(async () => {
      delete process.env.REBUY_TIMEOUT_MS;
      await h.close();
    });

    it('7. DB가 한 번도 불리지 않고, 재개 뒤 다시 물어 한 번만 반영된다', async () => {
      await bustAandB(h);
      const aPoints = await pointsOf(h, 'a');
      const tx = jest.spyOn(h.playsync, 'executeRebuyTransaction');

      // 수락한 a의 칩 쓰기를 락 안(스냅샷 읽기)에서 붙잡는다.
      const entered = latch();
      const gate = latch();
      let armed = false;
      const read = h.redisService.getSnapShot.bind(h.redisService);
      const hold = jest.spyOn(h.redisService, 'getSnapShot').mockImplementation(async (id: string) => {
        if (armed) { armed = false; entered.open(); await gate.opened; }
        return read(id);
      });

      let round = 0;
      h.emitter.on('rebuy.request.sent', ({ userId }: { userId: string }) => {
        setImmediate(() => {
          if (userId === 'b') return h.emitter.emit('rebuy_res_b', false);
          round += 1;
          if (round === 1) armed = true;
          h.emitter.emit('rebuy_res_a', true);
        });
      });

      const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);
      await entered.opened;
      await dropFor(h);
      gate.open();

      await until(() => outage(h).isUp());
      await until(async () => (await h.snapshot()).resumePending !== undefined);
      expect(`7. 재개 전 DB ${tx.mock.calls.length} 포인트 ${await pointsOf(h, 'a') === aPoints}`).toBe('7. 재개 전 DB 0 포인트 true');

      hold.mockRestore();
      await h.recovery.completeSync(h.tournamentId);
      await h.dealer.resumeTable(h.tableId);
      await settling;

      chips += SCENARIO.startStack;
      const after = await checkInvariants(h, '7. 재개 뒤', chips);
      expect(`7. DB ${tx.mock.calls.length} a스택 ${after.players[h.seatOf(after, 'a')]!.stack} a차감 ${aPoints - (await pointsOf(h, 'a'))}`)
        .toBe(`7. DB 1 a스택 ${SCENARIO.startStack} a차감 ${SCENARIO.entryFee}`);
    });
  });
});
