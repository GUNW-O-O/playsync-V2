import { SCENARIO, checkInvariants, forceClose, setupTournament, Harness } from './harness';

/**
 * 동시 요청 폭탄.
 *
 * 시나리오 계층이 순서대로 검증하는 불변식을, 같은 자원을 동시에 노리는
 * 요청 다발 위에서 다시 본다. 여기서 보는 이음매는 **경합의 최종 판정자가
 * 누구인가**다 — 락인가, 유니크 제약인가, 아니면 아무도 아닌가.
 */
describe('시나리오: 동시 요청 폭탄', () => {
  let h: Harness;

  afterEach(async () => { await h.close(); });
  afterAll(async () => { await forceClose(); });

  /** 유저를 만들고 참가비만 낸다. 좌석은 각 테스트가 경합으로 정한다. */
  async function payAll(h: Harness, ids: string[]) {
    await h.prisma.user.createMany({
      data: ids.map(id => ({
        id, nickname: id, password: 'x', points: SCENARIO.initialPoints,
      })),
    });
    for (const id of ids) {
      await h.payment.joinSession({ tournamentId: h.tournamentId }, id);
    }
  }

  /** 참가 OTP. 실제로는 폰의 마이페이지가 하는 일을 DB 조회로 대신한다. */
  async function otpsOf(h: Harness, ids: string[]) {
    const rows = await Promise.all(ids.map(userId =>
      h.prisma.tournamentParticipation.findUniqueOrThrow({
        where: { tournamentId_userId: { tournamentId: h.tournamentId, userId } },
      }),
    ));
    return rows.map(r => r.playerOtp);
  }

  it('같은 좌석을 다섯이 동시에 노리면 한 명만 앉는다', async () => {
    h = await setupTournament(['p1', 'p2'], {});
    const burst = ['b1', 'b2', 'b3', 'b4', 'b5'];
    await payAll(h, burst);
    const otps = await otpsOf(h, burst);

    const results = await Promise.allSettled(
      otps.map(otp => h.entry.enterSeat(h.tournamentId, {
        otp, tableId: h.tableId, seatIndex: 5,
      })),
    );

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 4');

    // 거절 사유가 "자리 싸움"으로 정확히 갈려야 한다. 이 메시지가 흐려지면
    // 딜러가 손님에게 무엇을 안내해야 하는지가 사라진다.
    for (const f of failed) {
      expect(`거절 ${(f.reason as Error).message}`)
        .toBe('거절 이미 다른 참가자가 앉은 좌석입니다.');
    }

    // 좌석 행은 하나. 비트맵과 스냅샷도 그 하나에만 동의해야 한다.
    const seatRows = await h.prisma.tablePlayer.count({
      where: { tableId: h.tableId, seatPosition: 5 },
    });
    expect(`좌석 행 ${seatRows}`).toBe('좌석 행 1');

    // 원래 둘 + 새로 앉은 하나.
    await checkInvariants(h, '좌석 폭탄 후', 3 * SCENARIO.startStack);
  });

  it('한 사람이 두 테이블에 동시에 앉으려 하면 한 자리만 얻는다', async () => {
    h = await setupTournament(['p1', 'p2'], {});
    const table2 = await h.session.createTable(h.tournamentId, SCENARIO.owner);
    await payAll(h, ['b1']);
    const [otp] = await otpsOf(h, ['b1']);

    // 같은 OTP로 서로 다른 테이블을 동시에 노린다. 테이블마다 락이 따로라
    // 락은 이 둘을 서로 막지 못한다 — `@@unique([tournamentId, userId])`가
    // 유일한 판정자다(`entry.service.ts:72-77`의 주석이 말하는 바로 그 경합).
    const results = await Promise.allSettled([
      h.entry.enterSeat(h.tournamentId, { otp, tableId: h.tableId, seatIndex: 5 }),
      h.entry.enterSeat(h.tournamentId, { otp, tableId: table2.id, seatIndex: 0 }),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 1');
    expect(`거절 ${(failed[0].reason as Error).message}`)
      .toBe('거절 이미 다른 좌석에 앉아 있습니다. 상점에 문의해주세요.');

    // 좌석 행은 대회 전체에서 하나.
    const rows = await h.prisma.tablePlayer.count({
      where: { tournamentId: h.tournamentId, userId: 'b1' },
    });
    expect(`b1 좌석 행 ${rows}`).toBe('b1 좌석 행 1');

    // 비트맵도 하나에만 동의한다. 어느 테이블이 이겼는지는 경합이 정하므로
    // 두 테이블의 켜진 비트를 합쳐서 본다 — 원래 둘 + b1 하나.
    const bitmaps = await h.redis.hgetall(`tournament:${h.tournamentId}:seat`);
    const bits = Object.values(bitmaps)
      .join('')
      .split('')
      .filter(c => c === '1').length;
    expect(`켜진 비트 ${bits}`).toBe('켜진 비트 3');
  });
});
