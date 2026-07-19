import { ActionType, GamePhase } from 'src/game-engine/types';
import { checkInvariants, Harness, setupTournament } from './harness';

/**
 * 제한 시간과 타임아웃.
 *
 * 오프라인 대회라 자리를 비우거나 반응이 없는 사람이 늘 생긴다. 타임아웃이
 * 없으면 그 테이블은 멈춘다.
 *
 * 이 경로에는 함정이 두 개 있었고 T2가 고쳤다.
 *
 * 1. **판정 기준이 도착 순서였다.** `actionDeadline`은 프론트가 카운트다운을
 *    그리는 데만 쓰였고 서버는 아무도 읽지 않았다. 즉 "30초가 지났는가"를
 *    판정하는 주체가 BullMQ 잡의 발화 시각뿐이었다 — 시간 기반 규칙을 이벤트
 *    도착 순서로 대체한 구조다. 마감 뒤에 도착한 버튼은 잡보다 먼저 와도
 *    시간 초과여야 한다.
 * 2. **낡은 잡이 남의 차례를 끝냈다.** `jobId`가 `tableId` 고정이라 제거에
 *    실패한 상태에서 다시 등록하면 BullMQ가 조용히 무시했다. `timerEpoch`가
 *    세대를 들고 다녀 자기 세대가 아니면 스스로 폐기한다.
 */
describe('시나리오 — 제한 시간과 타임아웃', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2'];
  const chips = 10000 * 3;

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
  });

  afterAll(async () => {
    await h.close();
  });

  it('1. 차례가 열리면 마감 시각과 타이머 세대가 함께 붙는다', async () => {
    const state = await checkInvariants(h, '프리플랍', chips);

    expect(state.actionDeadline).toBeDefined();
    expect(state.actionDeadline!).toBeGreaterThan(Date.now());
    expect(state.timerEpoch).toBeDefined();
  });

  it('2. 액션할 때마다 세대가 오른다', async () => {
    // 세대가 그대로면 이전 차례의 잡이 지금 차례를 끝낼 수 있다.
    const before = await h.snapshot();
    const epochBefore = before.timerEpoch!;
    const id = h.turnId(before)!;

    await h.playsync.handleAction(id, h.tableId, { action: ActionType.CALL } as never);

    const after = await checkInvariants(h, `콜 ${id}`, chips);
    expect(after.timerEpoch!).toBeGreaterThan(epochBefore);
  });

  it('3. 낡은 세대의 타임아웃은 아무것도 하지 않는다', async () => {
    // BullMQ는 at-least-once라 같은 잡이 두 번 배달될 수 있고, 실행 중인 잡은
    // 제거할 수 없다. 세대가 그 중복을 무해하게 만든다.
    const before = await h.snapshot();
    const id = h.turnId(before)!;
    const staleEpoch = before.timerEpoch! - 1;

    await h.playsync.handleAction(
      id, h.tableId, { action: ActionType.TIME_OUT } as never, staleEpoch,
    );

    const after = await checkInvariants(h, '낡은 타임아웃', chips);
    expect(after.currentTurnSeatIndex).toBe(before.currentTurnSeatIndex);
    expect(after.timerEpoch).toBe(before.timerEpoch);
    expect(after.players[h.seatOf(after, id)]!.hasFolded).toBe(false);
  });

  it('4. 마감이 지나서 도착한 액션은 시간 초과로 처리된다', async () => {
    // 태블릿에서 30초를 넘겨 누른 CHECK는, 타임아웃 잡보다 먼저 도착하더라도
    // 체크가 아니다. 도착 순서가 아니라 마감 시각이 판정 기준이다.
    const before = await h.snapshot();
    const id = h.turnId(before)!;

    before.actionDeadline = Date.now() - 1000; // 이미 지난 마감
    await h.saveSnapshot(before);

    await h.playsync.handleAction(id, h.tableId, { action: ActionType.CHECK } as never);

    const after = await checkInvariants(h, '지각 체크', chips);
    // TIME_OUT은 체크할 수 있으면 체크, 아니면 폴드다. 어느 쪽이든 차례는 넘어간다.
    expect(h.turnId(after)).not.toBe(id);
  });

  it('5. 현재 세대의 타임아웃은 차례를 넘긴다', async () => {
    const before = await h.snapshot();
    const id = h.turnId(before)!;

    await h.playsync.handleAction(
      id, h.tableId, { action: ActionType.TIME_OUT } as never, before.timerEpoch,
    );

    const after = await checkInvariants(h, `타임아웃 ${id}`, chips);

    // 차례가 "다른 사람"이 되는 것으로 단정하면 안 된다. 라운드가 끝나 페이즈가
    // 넘어가면 첫 행동자를 버튼 다음부터 다시 잡으므로 같은 사람에게 정당하게
    // 돌아올 수 있다. 검증할 것은 **그의 차례가 소비됐다**는 것이다.
    const consumed =
      after.phase !== before.phase || after.timerEpoch !== before.timerEpoch;
    expect(`소비됨 ${consumed}`).toBe('소비됨 true');
  });

  it('6. 타임아웃이 이어져도 라운드는 끝난다', async () => {
    // 전원이 자리를 비운 최악의 경우에도 테이블이 멎으면 안 된다. 예전에는
    // 타이머를 잃은 테이블이 라운드를 끝내지 못하고 멈췄다(P1-1).
    for (let guard = 0; guard < 30; guard++) {
      const state = await h.snapshot();
      if (state.phase === GamePhase.SHOWDOWN || state.phase === GamePhase.HAND_END) break;

      const id = h.turnId(state);
      if (!id) break;

      await h.playsync.handleAction(
        id, h.tableId, { action: ActionType.TIME_OUT } as never, state.timerEpoch,
      );
      await checkInvariants(h, `연속 타임아웃 ${id}`, chips);
    }

    const state = await h.snapshot();
    expect(state.phase).toBe(GamePhase.SHOWDOWN);
    expect(state.currentTurnSeatIndex).toBe(-1);
  });

  it('7. 쇼다운에서는 타임아웃 잡이 남아 있어도 상태를 바꾸지 못한다', async () => {
    // T8이 넣은 페이즈 가드. 승자 입력을 기다리는 동안 도착한 잡이 상태를
    // 건드리면 딜러가 보는 화면이 발밑에서 바뀐다.
    const before = await h.snapshot();
    const someone = before.players.find(p => p !== null)!.id;

    // 예외가 아니라 **무해**가 요점이다. 쇼다운에서는 `currentTurnSeatIndex`가
    // -1이라 턴 재검증(P1-3)에 먼저 걸려 조용히 돌아간다 — `act()`의 페이즈
    // 가드(T8)까지 가지도 않는다. 두 겹이 같은 것을 막고 있는 셈이다.
    await h.playsync.handleAction(
      someone, h.tableId, { action: ActionType.TIME_OUT } as never, before.timerEpoch,
    );

    const after = await checkInvariants(h, '쇼다운 중 타임아웃', chips);
    expect(after.phase).toBe(GamePhase.SHOWDOWN);
    expect(after.pot).toBe(before.pot);
    expect(after.currentTurnSeatIndex).toBe(-1);
    expect(after.players.map(p => p?.hasFolded ?? null))
      .toEqual(before.players.map(p => p?.hasFolded ?? null));
  });
});
