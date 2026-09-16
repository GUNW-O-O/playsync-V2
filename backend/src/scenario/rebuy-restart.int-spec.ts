import { JwtService } from '@nestjs/jwt';
import { DealerService } from 'src/dealer/dealer.service';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { PrismaService } from 'src/prisma/prisma.service';
import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T108 — **리바인 창이 열린 채 프로세스가 재시작한다.**
 *
 * `resolveWinners`는 세 구간인데 가운데(리바인 대기)가 락 밖이고, 그동안 판이
 * 진행되지 않는 근거는 **메모리**다 — `rebuyInFlight`와 `resumeWaiters`, 그리고
 * 호출 스택 자체. 프로세스가 죽으면 셋 다 사라지고, **3단계(탈락 확정)는 한 번도
 * 안 돈다.** 남는 것은 Redis의 스냅샷(`HAND_END`, 스택 0인 사람이 그대로 앉아
 * 있다)과 DB의 미탈락 참가 행뿐이다.
 *
 * 재시작한 프로세스에서 딜러가 나올 길은 `retryCheckpoint` 하나다(페이즈가
 * 문지기라 `startPreFlop`도 `resolveWinners`도 거절된다). 그 길이 `finishHand`
 * → `initTable`로 가는데, `initTable`은 **스택 0인 사람을 좌석에서 조용히
 * 지운다.** 탈락이 확정된 적이 없으므로 그 순간 사라지는 것이 셋이다 —
 * 등수와 상금, `activePlayers` 감소, 좌석 비트맵 정리.
 *
 * **장애가 아니어도 같다.** 여기서 Redis를 죽이지 않는 이유가 그것이다. T100의
 * 장애는 대기를 15초에서 「장애 + 딜러 재개」로 늘렸을 뿐, 그 창 안의 재시작은
 * 전부터 같은 자리로 온다. 장애까지 겹친 판은 실제 kill 무대가 든다
 * (`backend/test/outage/rebuy-kill.outage-spec.ts`).
 *
 * **재시작은 `DealerService`를 새로 지어서 흉내 낸다.** 하네스가 서비스를 손으로
 * 배선하므로 새 인스턴스의 메모리는 실제로 비어 있다 — 죽은 프로세스의 호출
 * (`abandoned`)은 그대로 버린다. private 필드를 손으로 비우지 않는 이유는, 비우는
 * 목록이 곧 두 번째 사본이 되어 필드가 늘 때 조용히 어긋나기 때문이다.
 */
describe('시나리오 — 리바인 창에 프로세스가 재시작한다', () => {
  const PLAYERS = ['a', 'b', 'winner'];
  const STACKS: Record<string, number> = { a: 1000, b: 5000, winner: 10000 };
  /** 3등까지 나눈다. 상금이 0이면 「등수를 못 받았다」와 「받았는데 0이다」가 안 갈린다. */
  const PAYOUTS = [
    { place: 1, percent: 60 },
    { place: 2, percent: 20 },
    { place: 3, percent: 20 },
  ];
  const CHIPS = STACKS.a + STACKS.b + STACKS.winner;

  let h: Harness;
  const prompts: { userId: string }[] = [];
  /** 죽은 프로세스의 호출. 배웅하는 자리는 `afterAll`이다. */
  let abandoned: Promise<unknown> = Promise.resolve();

  async function until(pred: () => boolean | Promise<boolean>, ms = 8000) {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('until timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const pointsOf = async (id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;
  const partOf = async (id: string) =>
    h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: id } },
    });
  const activePlayers = async () =>
    (await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } })).activePlayers;

  /** a만 파산시킨다. b는 칩을 남겨 대회가 이 핸드에서 끝나지 않게 한다. */
  async function bustA() {
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
  }

  /** 재시작한 프로세스의 딜러. 메모리가 비어 있다는 것이 이 객체의 전부다. */
  function restartedDealer() {
    return new DealerService(
      h.queue, h.prisma as unknown as PrismaService, h.redisService, h.playsync,
      {} as JwtService, new OtpAttempts(h.redis),
    );
  }

  beforeAll(async () => {
    // 마감이 지나면 `processRebuy`가 스스로 끝나 3단계가 돌아 버린다. 재시작이
    // **창이 열린 동안** 일어나야 하므로 창을 길게 잡는다.
    process.env.REBUY_TIMEOUT_MS = '60000';
    h = await setupTournament(PLAYERS, { registrationOpen: true, prizePayouts: PAYOUTS });
    h.emitter.on('rebuy.request.sent', (p: { userId: string }) => { prompts.push(p); });
  });
  afterAll(async () => {
    // **버린 호출을 배웅한다.** 60초짜리 리바인 타이머가 그 안에 살아 있어,
    // 그냥 두면 빨간불이 아니라 「jest가 안 닫힌다」로 끝난다. 답을 주면 고리가
    // 정상 경로로 빠져나가고, 이 시점의 테이블은 이미 다음 핸드라 그 뒤 단계는
    // 전부 무해하다 — 탈락은 대상이 없고 `finishHand`는 페이즈가 달라 안 쓴다.
    h.emitter.emit('rebuy_res_a', false);
    await abandoned.catch(() => { /* 죽은 프로세스의 호출 */ });
    delete process.env.REBUY_TIMEOUT_MS;
    await h.close();
  });

  it('1. 창이 열린 채 재시작해도 딜러가 나올 길이 있다', async () => {
    await bustA();
    await checkInvariants(h, '1. 쇼다운', CHIPS);

    // **버리는 호출이다.** 죽은 프로세스의 스택이라 아무도 이 결과를 안 받는다 —
    // 재개 대기는 영영 안 풀리고, 그것이 곧 재시작이 지우는 것이다.
    abandoned = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);
    abandoned.catch(() => { /* 배웅은 `afterAll`이 한다 */ });
    await until(() => prompts.some((p) => p.userId === 'a'));

    const held = await h.snapshot();
    expect(`1. 페이즈 ${held.phase} 리바인표시 ${held.rebuyPending !== undefined} a상태 ${(await partOf('a')).status}`)
      .toBe(`1. 페이즈 ${GamePhase.HAND_END} 리바인표시 true a상태 PLAYING`);

    // 재시작. 딜러가 누를 수 있는 것은 체크포인트 재시도뿐이다 — 페이즈가
    // `HAND_END`라 `startPreFlop`도 `resolveWinners`도 거절된다.
    const next = await restartedDealer().retryCheckpoint(h.tableId);
    expect(`1. 재시작 뒤 페이즈 ${next.phase} 리바인표시 ${next.rebuyPending !== undefined}`)
      .toBe(`1. 재시작 뒤 페이즈 ${GamePhase.WAITING} 리바인표시 false`);
  });

  /**
   * **탈락이 유실됐는지를 돈으로 묻는다.** 「좌석에서 사라졌다」만 보면
   * `initTable`이 지운 것과 탈락이 확정된 것이 구별되지 않는다 — 그 둘을
   * 가르는 것은 DB의 등수·상금과 `activePlayers`다.
   */
  it('2. 사라진 사람은 탈락으로 확정돼 있다 — 등수·상금·인원까지', async () => {
    const part = await partOf('a');
    const prize = Math.floor(SCENARIO.entryFee * PLAYERS.length * 0.2);
    // 상금이 나간 사람은 `AWARDED`다 — `ELIMINATED`는 상금권 밖에서 끝난 사람이다.
    expect(`2. a상태 ${part.status} a등수 ${part.finalPlace} a상금 ${part.prizeAmount} a포인트 ${await pointsOf('a')} 남은인원 ${await activePlayers()}`)
      .toBe(`2. a상태 AWARDED a등수 3 a상금 ${prize} a포인트 ${SCENARIO.initialPoints - SCENARIO.entryFee + prize} 남은인원 2`);
  });

  /** 좌석 비트맵까지 정리됐는가. 안 지워지면 그 자리에 아무도 못 앉는다. */
  it('3. 좌석 비트맵과 스냅샷이 다시 일치한다', async () => {
    const state = await checkInvariants(h, '3. 재시작 뒤', CHIPS);
    expect(`3. a좌석 ${state.players.some((p) => p?.id === 'a')}`).toBe('3. a좌석 false');
  });

  /** 나올 길이 진짜 열렸는가 — 다음 핸드가 실제로 돈다. */
  it('4. 다음 핸드가 돈다', async () => {
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    const state = await checkInvariants(h, '4. 다음 핸드', CHIPS);
    expect(`4. 페이즈 ${state.phase}`).toBe(`4. 페이즈 ${GamePhase.PRE_FLOP}`);
  });
});
