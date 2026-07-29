import { SCENARIO, checkInvariants, chipsOnTable, forceClose, setupTournament, Harness } from './harness';

/**
 * 테이블 간 인원 이동.
 *
 * 부품은 각각 옳은데 조립이 틀린 경우를 잡는 계층이다. 여기서 보는 이음매는
 * **칩이 좌석보다 오래 사는가**다 — 해제가 `TablePlayer`를 지우고, 사람이
 * 다른 테이블에 앉을 때 그 칩이 그대로 따라오는지.
 */
describe('시나리오: 두 테이블 사이의 이동', () => {
  let h: Harness;
  const PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  afterAll(async () => { await forceClose(); });

  it('해제한 사람이 다른 테이블에 원래 칩으로 앉는다', async () => {
    h = await setupTournament(PLAYERS, {});
    const total = PLAYERS.length * SCENARIO.startStack;

    await checkInvariants(h, '1. 착석 직후', total);

    // 두 번째 테이블을 만든다. 상점의 조작이다.
    const table2 = await h.session.createTable(h.tournamentId, SCENARIO.owner);

    // p4의 칩을 옮기기 전에 바꿔 둔다 — startStack 그대로면 이사가 없어도
    // 통과해 버린다.
    await h.prisma.tournamentParticipation.update({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'p4' } },
      data: { currentStack: 17300 },
    });
    const state = await h.snapshot();
    const seat4 = h.seatOf(state, 'p4');
    state.players[seat4]!.stack = 17300;
    await h.saveSnapshot(state);

    const expected = total - SCENARIO.startStack + 17300;
    await checkInvariants(h, '2. 스택 조정 후', expected);

    // 쉬는 시간. 상점이 p4를 자리에서 뗀다.
    await h.session.releaseSeats(
      h.tournamentId, h.tableId, [{ seatIndex: seat4, userId: 'p4' }], SCENARIO.owner,
    );

    const afterRelease = await h.snapshot();
    expect(`해제 후 1번 테이블 인원 ${afterRelease.players.filter(p => p !== null).length}`)
      .toBe('해제 후 1번 테이블 인원 3');
    expect(`해제 후 1번 테이블 칩 ${chipsOnTable(afterRelease)}`)
      .toBe(`해제 후 1번 테이블 칩 ${total - SCENARIO.startStack}`);

    const p4 = await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: 'p4' } },
    });
    expect(`해제된 사람 상태 ${p4.status} / 칩 ${p4.currentStack}`)
      .toBe('해제된 사람 상태 WAITING / 칩 17300');

    // 걸어가서 2번 테이블 0번 자리에 앉아 OTP를 넣는다. p4는 이미 결제를
    // 마친 참가자라(위에서 조회한 p4.playerOtp) `h.seatPlayer`(결제+입장 묶음)를
    // 다시 부르면 안 된다 — 그러면 `payment.joinSession`이 이미 존재하는
    // 참가 행에 걸린 `@@unique([tournamentId, userId])`로 P2002를 던진다.
    // 딜러/상점을 거치지 않고 본인 태블릿에서 OTP를 입력하는 경로 그대로
    // `entry.enterSeat`을 직접 부른다.
    await h.entry.enterSeat(h.tournamentId, {
      otp: p4.playerOtp, tableId: table2.id, seatIndex: 0,
    });

    const t2 = await h.redisService.getSnapShot(table2.id);
    expect(`2번 테이블 p4 칩 ${t2!.players[0]!.stack}`).toBe('2번 테이블 p4 칩 17300');

    await checkInvariants(h, '3. 이동 후 1번 테이블', total - SCENARIO.startStack);
    await checkInvariants(h, '4. 이동 후 2번 테이블', 17300, table2.id);
  });
});
