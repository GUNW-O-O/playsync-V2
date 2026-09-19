import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T109 — **마지막 탈락이 커밋된 뒤에 끊기면, 재시도가 우승 상금까지 가야 한다.**
 *
 * `eliminatePlayer`는 탈락 확정(DB 트랜잭션)과 우승 상금(`tournamentFinished`)이
 * 다른 트랜잭션이다. 그 사이에서 프로세스가 죽거나 무엇이 던지면 우승 상금이 안
 * 나간다. 다시 오는 길(`retryCheckpoint` → `finishHand` →
 * `eliminateBusted`)은 탈락이 이미 확정돼 있어 「중복 도착」으로 보이는데, 예전에는
 * 그 판정이 **조기 반환**이라 상금 자리에 닿지 않았다. 우승자가 상금을 못 받으면
 * `completeSession`의 게이트(걷은 것 == 상금 + 몫)가 영영 안 맞는다.
 *
 * 같은 조기 반환이 좌석 비트맵 정리도 건너뛰어, 파산자의 비트가 켜진 채 남았다.
 *
 * 끊김은 커밋 직후의 `tournamentFinished`를 한 번 던지게 해서 흉내 낸다.
 * 프로세스가 그 자리에서 죽는 것과 다시 오는 길이 같다. Redis 장애는 이제
 * 상금보다 뒤라 상금을 막지 못한다 — 그 순서는 `elimination.int-spec.ts`가 본다.
 */
describe('시나리오 — 마지막 탈락 커밋 뒤에 끊긴다', () => {
  const PLAYERS = ['a', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, winner: 10000 };
  const CHIPS = STACKS.a + STACKS.winner;
  const POOL = SCENARIO.entryFee * PLAYERS.length;

  let h: Harness;

  const partOf = async (id: string) =>
    h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: id } },
    });
  const pointsOf = async (id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
    // 등록을 닫아 리바인 없이 곧바로 탈락하게 한다. 셋업 전에 닫으면 결제가 막힌다.
    await h.prisma.tournament.update({
      where: { id: h.tournamentId }, data: { isRegistrationOpen: false },
    });
    await h.redis.hset(`tournament:${h.tournamentId}:info`, 'isRegistrationOpen', '0');
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  it('1. 커밋 뒤에 끊기면 핸드가 HAND_END에 멈춘다', async () => {
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
      const target = Math.min(me.stack + me.bet, STACKS.a);
      const action = target > s.currentBet ? ActionType.RAISE : ActionType.CALL;
      await h.playsync.handleAction(id, h.tableId,
        { action, ...(action === ActionType.RAISE ? { amount: target } : {}) } as never);
    }

    jest.spyOn(h.playsync, 'tournamentFinished')
      .mockRejectedValueOnce(new Error('커밋 직후 끊김'));
    await expect(h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]))
      .rejects.toThrow('커밋 직후 끊김');

    // 탈락은 커밋됐고 우승 상금은 아직이다 — 그것이 이 시나리오의 출발점이다.
    const held = await h.snapshot();
    expect(`1. 페이즈 ${held.phase} a ${(await partOf('a')).status} winner ${(await partOf('winner')).status}`)
      .toBe(`1. 페이즈 ${GamePhase.HAND_END} a ELIMINATED winner PLAYING`);
  });

  it('2. 딜러의 재시도가 우승 상금까지 간다', async () => {
    await h.dealer.retryCheckpoint(h.tableId);
    const part = await partOf('winner');
    expect(`2. winner ${part.status} 등수 ${part.finalPlace} 상금 ${part.prizeAmount} 포인트 ${await pointsOf('winner')}`)
      .toBe(`2. winner AWARDED 등수 1 상금 ${POOL} 포인트 ${SCENARIO.initialPoints - SCENARIO.entryFee + POOL}`);
  });

  it('3. 좌석 비트맵과 스냅샷이 다시 일치한다', async () => {
    await checkInvariants(h, '3. 재시도 뒤', CHIPS);
  });

  it('4. 대회를 닫을 수 있다', async () => {
    await h.session.completeSession(h.tournamentId, SCENARIO.owner);
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`4. 상태 ${t.status}`).toBe('4. 상태 FINISHED');
  });
});
