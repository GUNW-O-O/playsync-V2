import { ActionType } from 'src/game-engine/types';
import { checkInvariants, Harness, setupTournament } from './harness';

/**
 * T94·T95 — 서버가 멈췄다 돌아왔을 때 판을 어떻게 다시 여나.
 *
 * 부품은 각자 통합 스펙이 든다(복구는 `recovery.service.int-spec.ts`, 규칙은
 * `turn-clock.spec.ts`). 여기서 보는 것은 **조립**이다 — 복구가 멈춰 세운
 * 테이블에서 사람이 실제로 못 누르고, 딜러가 열면 그때 시계가 다시 가는가.
 *
 * ## 무엇이 깨져 있었나
 *
 * 정지 동안 블라인드 시계는 `RecoveryService`가 밀어 주는데 **액션 시계는
 * 아무도 밀지 않았다.** 그래서 재시작하면 차례였던 사람이 테이블마다 한 명씩
 * 자동 폴드됐다. 경로가 둘이고 서로 독립이다 — 큐에 남아 부팅 직후 발화하는
 * 잡, 그리고 절대 시각이라 이미 지나 있는 마감.
 *
 * ## 왜 자동으로 재개하지 않나
 *
 * 부팅은 정지의 끝이 아니다. 프로세스가 떠도 태블릿이 돌아와야 판이 돈다 —
 * 실측으로 660소켓이 제품 기본 상한에서 전부 돌아오는 데 31.9초였고, 사람이
 * 태블릿을 집어 드는 시간은 그 위에 얹힌다. 소켓 수를 세는 방법은 게이트웨이에
 * 하트비트가 없어(반만 닫힌 TCP는 살아 있는 것처럼 보인다) 좀비 소켓 하나가
 * 테이블을 영영 묶는다. **카드가 물리라 딜러에게는 눈이 있다.**
 */
describe('시나리오 — 정지와 재개', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;
  const DOWNTIME_MS = 180_000;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 판이 돌고 있다 — 차례에 마감이 붙어 있다', async () => {
    const state = await checkInvariants(h, '프리플랍', chips);
    expect(`마감 ${state.actionDeadline !== undefined} 정지 ${state.resumePending === undefined}`)
      .toBe('마감 true 정지 true');
  });

  /**
   * **멈춘 적 없는 테이블에 재개가 오면 거절한다.** 조용히 통과시키면 지금
   * 차례인 사람의 30초가 딜러의 오조작 한 번에 되감긴다 — 이 검사가 없으면
   * "언제나 타이머를 다시 건다"는 구현도 아래 4번을 통과한다.
   *
   * **멈추기 전에 본다.** 하네스가 모듈 수준 핸들을 쓰므로 두 번째 대회를
   * 나란히 세울 수 없다 — 뒤에 세운 쪽이 앞의 Redis를 지운다.
   */
  it('1-1. 멈춘 적 없는 테이블은 재개할 수 없다', async () => {
    await expect(h.dealer.resumeTable(h.tableId)).rejects.toThrow(/멈춰 있는 테이블이 아닙니다/);
    await checkInvariants(h, '재개 거절', chips);
  });

  it('2. 서버가 3분 멈췄다 돌아온다 — 마감이 사라지고 정지 표시가 선다', async () => {
    await h.prisma.serverHeartbeat.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', beatAt: new Date(Date.now() - DOWNTIME_MS) },
      update: { beatAt: new Date(Date.now() - DOWNTIME_MS) },
    });

    await h.recovery.recoverAll();

    const state = await h.snapshot();
    // 마감을 남겨 두면 돌아온 사람이 누른 버튼이 시간 초과로 바뀐다 —
    // `handleAction`의 판정 기준이 도착 순서가 아니라 마감 시각이라서다.
    expect(state.actionDeadline).toBeUndefined();
    expect(state.resumePending!.downMs).toBeGreaterThan(DOWNTIME_MS - 10_000);

    // 부팅이 SYNCING을 켠다(T96) — 끄는 것은 딜러 n/n(`completeSync`)이다.
    const t = await h.prisma.tournament.findUniqueOrThrow({ where: { id: h.tournamentId } });
    expect(`2. 상태 ${t.status}`).toBe('2. 상태 SYNCING');
  });

  /**
   * **멈춤이 실제로 멈춰야 한다.** 표시만 세우고 액션을 받으면, 먼저 돌아온
   * 사람이 눌러서 판이 진행된다 — 그 구간의 테이블 위는 아무도 모르는
   * 상태이고, 딜러가 그것을 되돌릴 근거가 테이블 위에 없다.
   */
  it('3. 멈춰 있는 동안에는 아무도 액션할 수 없다', async () => {
    const state = await h.snapshot();
    const id = h.turnId(state)!;

    await expect(
      h.playsync.handleAction(id, h.tableId, { action: ActionType.CALL } as never),
    ).rejects.toThrow(/딜러가 판을 다시 열/);

    // 거절이 상태를 건드리지 않았는지까지 본다. 던지고 나서 절반만 쓰면
    // 칩 총량이 어긋난다.
    await checkInvariants(h, '정지 중 거절', chips);
  });

  it('4. 딜러가 열면 마감이 다시 붙고 정지 표시가 사라진다', async () => {
    const before = await h.snapshot();
    const epochBefore = before.timerEpoch!;

    // 재개는 n/n 뒤다(T96) — 딜러가 열기 전에 게이트웨이가 completeSync로
    // SYNCING을 먼저 끈다.
    const result = await h.recovery.completeSync(h.tournamentId);
    expect(`4. completeSync ${result}`).toBe('4. completeSync true');

    await h.dealer.resumeTable(h.tableId);

    const state = await checkInvariants(h, '재개', chips);
    expect(state.resumePending).toBeUndefined();
    expect(state.actionDeadline!).toBeGreaterThan(Date.now());
    // 세대가 또 올라야 정지 중에 남은 잡이 새 잡과 같은 세대가 되지 않는다.
    expect(state.timerEpoch!).toBeGreaterThan(epochBefore);
  });

  it('5. 재개한 뒤에는 다시 누를 수 있다', async () => {
    const state = await h.snapshot();
    const id = h.turnId(state)!;

    await h.playsync.handleAction(id, h.tableId, { action: ActionType.CALL } as never);

    const after = await checkInvariants(h, `콜 ${id}`, chips);
    expect(h.turnId(after)).not.toBe(id);
  });
});
