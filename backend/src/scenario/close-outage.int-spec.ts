import { TournamentStatus } from '@prisma/client';
import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, SCENARIO, setupTournament } from './harness';

/**
 * T103 — Redis가 죽은 동안 상점이 대회를 닫는다.
 *
 * **스텁은 없다.** 장애는 실제 ioredis 클라이언트를 `disconnect(true)`로 끊고
 * `retryStrategy`로 돌아올 시각을 쥔다(T97 · T100 시나리오와 같다). 그래서
 * `deleteTournament`의 pipeline이 **진짜로 끊긴 연결**을 만난다 — 단위·통합의
 * `phase` 플래그로는 그 자리가 서지 않는다.
 *
 * 이음매가 셋이다.
 *
 * 1. **닫기 × 장애** — DB는 커밋되는데 Redis 정리가 던진다. 예전에는 그 예외가
 *    `announceClosed`를 통째로 건너뛰게 만들어, 상점이 다시 눌러도 409라 정리가
 *    영영 안 돌았다(`SessionService.finishClose`)
 * 2. **닫힘 알림 × 리바인 고리** — 알림이 재개 대기를 푸는데, 장애 중에는
 *    스냅샷이 아직 안 지워져 있어 고리가 파산자를 그대로 읽는다
 *    (`DealerService.closedTables`)
 * 3. **미뤄 둔 정리 × 복구 스윕** — 둘 다 `outage.whenUp()`에 매달려 있고,
 *    깨어나는 순서가 등록 순서다
 *
 * 셋은 각각 단위·통합이 재지만, **어느 쪽도 셋이 한 무대에서 맞물리는 것을
 * 보지 않는다.**
 */
describe('시나리오 — Redis가 죽은 동안 대회를 닫는다', () => {
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
  const pointsOf = async (h: Harness, id: string) =>
    (await h.prisma.user.findUniqueOrThrow({ where: { id } })).points;

  /** a와 b를 스택 0으로 만들고 쇼다운까지 간다. `rebuy-outage`와 같은 모양이다. */
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

  /**
   * 끊는다. **오프라인 큐도 끈다.**
   *
   * 운영 클라이언트는 `maxRetriesPerRequest` 기본 20이라, 장애 중에 나간 명령은
   * 예산을 다 쓴 **뒤에** 거절된다(실측 7~10초). 이 무대의 장애는 1.5초짜리라
   * 큐를 그대로 두면 명령이 재접속까지 앉았다 **성공한다** — 그러면 「거절되는
   * 자리」가 서지 않아, 장애 중 닫기가 그냥 느린 성공으로 보인다.
   *
   * 큐를 끄면 오프라인 중의 명령이 곧바로 거절돼, 예산을 다 쓴 **최종 상태**가
   * 짧은 무대에 그대로 선다. 10초를 기다리는 대신 그 끝을 앞당긴다.
   */
  async function dropFor(h: Harness) {
    h.redis.options.retryStrategy = () => HOLD_MS;
    h.redis.options.enableOfflineQueue = false;
    h.redis.disconnect(true);
    await until(() => outage(h).phase === 'down');
  }

  let h: Harness;
  const chips = STACKS.a + STACKS.b + STACKS.winner;
  const prompts: { userId: string }[] = [];
  const closed: { tournamentId: string; tableIds: string[]; status: string }[] = [];
  /** 정리를 **부른 시점의 장애 단계**. 장애 중에 부르면 요청이 재시도만큼 붙잡힌다. */
  const cleanupPhases: string[] = [];
  /** 미뤄 둔 정리를 붙잡는 빗장. 아래 주석 참고. */
  let releaseCleanup!: () => void;
  const cleanupHeld = new Promise<void>((resolve) => { releaseCleanup = resolve; });

  beforeAll(async () => {
    // 되돌림 확인용 여유다. 이 무대의 첫 라운드는 마감이 아니라 장애로 끝나므로
    // 값이 짧아도 초록 경로는 그대로지만, 검사를 되돌려 「다시 묻는」 구현이
    // 되면 두 번째 라운드가 이 마감으로 끝나야 검사가 멎지 않고 빨개진다.
    process.env.REBUY_TIMEOUT_MS = '5000';
    h = await setupTournament(PLAYERS, { registrationOpen: true });
    h.emitter.on('rebuy.request.sent', (p: { userId: string }) => { prompts.push(p); });

    // 원래 동작을 그대로 통과시키고 **부른 시점만** 적는다. `SessionService`가
    // 이 인스턴스를 그대로 들고 있다(하네스가 하나를 셋에 나눠 준다).
    //
    // **up에서 부른 정리는 고리가 끝날 때까지 붙잡는다.** 복구 직후 정리와
    // 리바인 고리는 같은 `whenUp`에 매달려 있어 실행 순서가 왕복 수에 좌우된다 —
    // 실측으로는 pipeline 하나뿐인 정리가 락부터 잡아야 하는 고리보다 먼저
    // 끝나고, 그러면 고리는 「스냅샷 없음」으로 끝나 `closedTables`를 한 번도
    // 안 지난다. **경합을 왕복 타이밍에 맡기지 않는다**(`CLAUDE.md`) — 정리를
    // 붙잡아 「스냅샷이 살아 있는 채로 깨어난 고리」를 반드시 만든다. 그 상태가
    // 이 티켓이 막으려는 바로 그 상태다.
    //
    // 장애 중 호출은 붙잡지 않는다. 붙잡으면 되돌림 확인에서 상점 요청이
    // 영영 안 끝나 「빨간불」이 아니라 「멈춤」이 된다.
    const originalDelete = h.redisService.deleteTournament.bind(h.redisService);
    jest.spyOn(h.redisService, 'deleteTournament').mockImplementation(async (id, tables) => {
      const phase = outage(h).phase;
      cleanupPhases.push(phase);
      if (phase === 'up') await cleanupHeld;
      await originalDelete(id, tables);
    });

    // **`@OnEvent`은 하네스가 배선하지 않는다.** `AppModule`을 부팅하지 않고
    // 서비스를 손으로 조립하므로 Nest의 디스커버리가 안 돈다. 프로덕션에서
    // `EventEmitterModule`이 하는 일을 그대로 손으로 잇는다 — 스텁이 아니라
    // 배선이고, 그래서 `announceClosed`가 내는 페이로드가 실제로
    // `handleTournamentClosed`의 모양과 맞는지도 함께 증명된다.
    h.emitter.on('TOURNAMENT_CLOSED', (p: { tournamentId: string; tableIds: string[]; status: string }) => {
      closed.push(p);
      h.dealer.handleTournamentClosed(p);
    });
  });

  afterAll(async () => {
    delete process.env.REBUY_TIMEOUT_MS;
    await h.close();
  });

  it('1~7. 닫기는 던지지 않고, 알림은 장애 중에 나가고, 정리는 복구 뒤에 돌고, 리바인은 다시 묻지 않는다', async () => {
    await bustAandB(h);
    await checkInvariants(h, '1. 쇼다운', chips);
    const aPointsBefore = await pointsOf(h, 'a');

    const settling = h.dealer.resolveWinners(h.tableId, h.tournamentId, [['winner']]);

    // 2. 둘에게 묻는다.
    await until(() => prompts.some(p => p.userId === 'a') && prompts.some(p => p.userId === 'b'));

    // 3. 끊는다 — 대기는 마감(60초)을 안 기다리고 중단으로 끝나고, 고리는
    //    `holdForDealer`의 `whenUp`에 선다. 그 자리에 섰다는 증거가
    //    `resumeWaiters`다(메모리라 장애 중에도 읽힌다).
    await dropFor(h);
    await until(() => h.dealer['resumeWaiters'].has(h.tableId));

    // 4. **장애 한복판에서 상점이 중단을 누른다.** 던지지 않아야 한다 —
    //    503을 돌려주면 상점이 다시 눌러 409를 받고, 그때는 정리를 안 하므로
    //    영영 안 돈다.
    expect(outage(h).phase).toBe('down');
    await h.session.abortSession(h.tournamentId, SCENARIO.owner);

    // 5. 알림은 **곧바로** 나갔고 DB도 닫혔다 — 아직 장애 중이다.
    const aborted = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    // **정리는 아직 시도조차 안 했다.** 장애 중에 부르면 재시도만큼(운영 실측
    // 7~10초) 상점 요청이 붙잡히고, 그동안 단말은 끝난 대회를 계속 그린다.
    expect(cleanupPhases).toEqual([]);
    expect(`장애 ${outage(h).phase} 알림 ${closed.length} 상태 ${aborted.status} 환불 ${await pointsOf(h, 'a') > aPointsBefore}`)
      .toBe(`장애 down 알림 1 상태 ${TournamentStatus.CANCELLED} 환불 true`);
    expect(closed[0]).toEqual({
      tournamentId: h.tournamentId, tableIds: [h.tableId], status: TournamentStatus.CANCELLED,
    });

    // 6. 돌아온다. 복구 스윕이 `markRecovered`를 부르고, 그때 미뤄 둔 정리와
    //    리바인 고리가 **등록 순서대로** 깨어난다.
    //    큐는 되돌린다 — 복구 뒤의 정리·고리는 정상 클라이언트로 돌아야 한다.
    h.redis.options.enableOfflineQueue = true;
    await until(() => outage(h).isUp());

    // 7. **고리는 스냅샷이 살아 있는 채로 깨어난다**(정리를 붙잡아 뒀다).
    //    닫힘을 기억하지 않으면 여기서 파산자를 그대로 읽어 다시 묻는다.
    await settling.catch(() => { /* 닫힌 대회라 뒤가 던져도 괜찮다 */ });
    expect(`a묻기 ${prompts.filter(p => p.userId === 'a').length}`).toBe('a묻기 1');

    // 8. 빗장을 푼다 — 그제서야 정리가 돈다.
    //
    //    `tournament:{id}:info`로 재는 이유: `table:state:*`는 리바인 고리도
    //    쓰는 키라, 지우기와 `mutateSnapshot`의 읽기·쓰기가 겹치면 되살아날 수
    //    있다(잔여 목록 「닫힘과 겹친 스냅샷 쓰기」 — T103이 만든 것이 아니다).
    //    대회 키는 닫는 쪽만 만지므로 정리가 돌았는지를 흔들림 없이 가른다.
    releaseCleanup();
    await until(async () => await h.redis.exists(`tournament:${h.tournamentId}:info`) === 0);
    await until(() => h.dealer['rebuyInFlight'].has(h.tableId) === false);
    expect(`대회키 ${await h.redis.exists(`tournament:${h.tournamentId}:info`)} a묻기 ${prompts.filter(p => p.userId === 'a').length} 재개대기 ${h.dealer['resumeWaiters'].has(h.tableId)} 닫힘표시 ${h.dealer['closedTables'].has(h.tableId)}`)
      .toBe('대회키 0 a묻기 1 재개대기 false 닫힘표시 false');
    // 정리는 **딱 한 번**, up이 된 뒤에 돌았다.
    expect(cleanupPhases).toEqual(['up']);
  });
});
