import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * 스택이 0이 된 사람에게 무슨 일이 일어나는가.
 *
 * 정산 직후 갈림길이 있다. 등록이 열려 있으면 리바인을 묻고, 수락하면 그
 * 자리에서 살아난다. 거절하거나 등록이 닫혀 있으면 탈락이다.
 *
 * **리바인 대기는 락 밖이어야 한다** — 최대 15초짜리 사람의 입력이라, 락 안에
 * 두면 그동안 테이블 전체가 멎는다. 대신 `HAND_END`가 문지기 역할을 한다
 * (`startPreFlop`은 `WAITING`만 받는다). T5가 만든 구조가 여기서 돈다.
 *
 * 리바인은 칩이 **정당하게 늘어나는** 유일한 경로다. 그래서 이 시나리오만
 * 칩 총량 기대값을 도중에 갱신한다.
 */
describe('시나리오 — 탈락과 리바인', () => {
  let h: Harness;
  const PLAYERS = ['loser', 'winner'];

  const STACKS: Record<string, number> = { loser: 1000, winner: 10000 };
  let chips = 1000 + 10000;

  /** 리바인 팝업이 오면 자동으로 응답하는 태블릿 역할. */
  function answerRebuy(accept: boolean) {
    const handler = ({ userId }: { userId: string }) => {
      h.emitter.emit(`rebuy_res_${userId}`, accept);
    };
    h.emitter.on('rebuy.request.sent', handler);
    return () => h.emitter.off('rebuy.request.sent', handler);
  }

  /** 한 핸드를 돌려 loser를 올인시키고 winner가 이기게 한다. */
  async function playHandWhereLoserBusts() {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);

    for (let guard = 0; guard < 12; guard++) {
      const state = await h.snapshot();
      if (state.phase === GamePhase.SHOWDOWN) break;
      const id = h.turnId(state);
      if (!id) break;

      const me = state.players[h.seatOf(state, id)]!;
      const target = Math.min(me.stack + me.bet, STACKS.loser);
      const action = target > state.currentBet ? ActionType.RAISE : ActionType.CALL;

      await h.playsync.handleAction(
        id, h.tableId,
        { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never,
      );
    }
  }

  beforeAll(async () => {
    h = await setupTournament(PLAYERS, { registrationOpen: true });

    const state = await h.snapshot();
    for (const p of state.players) {
      if (p) p.stack = STACKS[p.id];
    }
    await h.saveSnapshot(state);
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. loser가 올인해서 지고 스택이 0이 된다', async () => {
    await playHandWhereLoserBusts();

    const state = await checkInvariants(h, '쇼다운', chips);
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.players[h.seatOf(state, 'loser')]!.isAllIn).toBe(true);
  });

  it('2. 리바인을 수락하면 그 자리에서 스택이 채워진다', async () => {
    const stop = answerRebuy(true);
    const pointsBefore = (await h.prisma.user.findUniqueOrThrow({
      where: { id: 'loser' },
    })).points;

    await h.dealer.resolveWinners(h.tableId, h.tournamentId, ['winner']);
    stop();

    // 리바인만큼 테이블 위 칩이 늘어난다. 유일하게 정당한 증가다.
    chips += SCENARIO.startStack;

    const state = await checkInvariants(h, '리바인 후', chips);
    expect(state.players[h.seatOf(state, 'loser')]!.stack).toBe(SCENARIO.startStack);
    expect(state.phase).toBe(GamePhase.WAITING);

    // 참가비는 포인트에서 빠졌는가. 스택만 늘고 돈이 안 빠지면 칩이 공짜다.
    const pointsAfter = (await h.prisma.user.findUniqueOrThrow({
      where: { id: 'loser' },
    })).points;
    expect(pointsAfter).toBe(pointsBefore - SCENARIO.entryFee);

    // 살아났으므로 탈락이 아니다.
    const row = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'loser' },
    });
    expect(row.status).not.toBe('ELIMINATED');
  });

  it('3. 리바인 대기 중에는 다음 핸드가 시작되지 않는다', async () => {
    // 대기가 락 밖이라 그 구간에 다른 명령이 도착할 수 있다. HAND_END가
    // 문지기다 — 여기가 뚫리면 정산 중인 테이블에서 새 핸드가 시작된다.
    const state = await h.snapshot();
    state.phase = GamePhase.HAND_END;
    await h.saveSnapshot(state);

    await expect(
      h.dealer.startPreFlop(h.tournamentId, h.tableId),
    ).rejects.toThrow(/대기 상태가 아닙니다/);

    state.phase = GamePhase.WAITING;
    await h.saveSnapshot(state);
  });

  it('4. 리바인을 거절하면 탈락한다', async () => {
    // 스택을 다시 벌려 같은 판을 한 번 더 돌린다.
    const before = await h.snapshot();
    const total = before.players.reduce((s, p) => s + (p?.stack ?? 0), 0);
    for (const p of before.players) {
      if (p) p.stack = p.id === 'loser' ? 1000 : total - 1000;
    }
    await h.saveSnapshot(before);
    chips = total;

    await playHandWhereLoserBusts();

    const stop = answerRebuy(false);
    await h.dealer.resolveWinners(h.tableId, h.tournamentId, ['winner']);
    stop();

    const row = await h.prisma.tournamentParticipation.findFirstOrThrow({
      where: { tournamentId: h.tournamentId, userId: 'loser' },
    });
    expect(row.status).toBe('ELIMINATED');
    expect(row.finalPlace).not.toBeNull();
  });

  it('5. 탈락하면 좌석과 스냅샷에서 함께 사라진다', async () => {
    // 킥과 다르다. 킥은 자리에 남아 칩이 블라인드로 녹지만, 스택이 0인 탈락은
    // 남길 칩이 없다. 좌석이 비어야 다음 사람이 앉을 수 있다.
    const state = await h.snapshot();
    expect(state.players[h.seatOf(state, 'loser')]).toBeUndefined();

    const bitmap = await h.redis.hget(
      `tournament:${h.tournamentId}:seat`, `table:${h.tableId}`,
    );
    const seated = (bitmap ?? '').split('').filter(c => c === '1').length;
    expect(seated).toBe(state.players.filter(p => p !== null).length);

    const row = await h.prisma.tablePlayer.findFirst({
      where: { tableId: h.tableId, userId: 'loser' },
    });
    expect(row).toBeNull();
  });

  it('6. 탈락이 두 번 도착해도 인원이 두 번 줄지 않는다', async () => {
    // N-7. 체크포인트 재시도가 붙은 뒤로 중복 도착은 정상 경로다.
    const before = await h.prisma.tournament.findUniqueOrThrow({
      where: { id: h.tournamentId },
    });

    const dashboard = await h.redisService.getTournamentDashboard(h.tournamentId);
    await h.playsync.eliminatePlayer(
      h.tournamentId, h.tableId,
      [{ id: 'loser', seatIndex: 0 } as never],
      dashboard!,
    );

    const after = await h.prisma.tournament.findUniqueOrThrow({
      where: { id: h.tournamentId },
    });
    expect(after.activePlayers).toBe(before.activePlayers);
  });
});
