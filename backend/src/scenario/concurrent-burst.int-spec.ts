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

  /**
   * **이 테스트는 테이블 락을 증명하지 않는다.** 락을 무력화해도(락 키에
   * 난수를 붙여 상호 배제를 없애도) 빨개지지 않는 것을 두 번 확인했다.
   *
   * 이유가 셋이고 전부 도메인에서 나온다.
   *
   * 1. 홀덤은 한 번에 한 사람만 차례라, 플레이어끼리는 동시에 정당하게
   *    상태를 바꾸는 둘을 만들 수 없다. 여럿이 동시에 밀어도 락이
   *    직렬화하는 동안 차례가 넘어가 다음 사람의 대기 액션이 정당하게
   *    반영되는 사슬이 돌 뿐이고, 사슬 길이는 도착 순서가 정한다.
   * 2. 다른 경로(`enterSeat`)는 Redis 스냅샷에 닿기 전에 Prisma 왕복을
   *    여러 번 거친다. `handleAction`은 곧장 Redis로 들어가므로 둘의
   *    시간대가 겹치지 않는다 — 레이스 창 자체가 열리지 않는다.
   * 3. 스냅샷은 Redis 키 하나를 통째로 read-modify-SET한다. 잃어버린
   *    갱신이 생겨도 남은 상태는 그 자체로 내적 일관성을 유지해서,
   *    상태 내부만 보는 불변식으로는 검출되지 않는다.
   *
   * 락의 상호 배제는 `redis.service.int-spec.ts`가 이미 잡는다. 착석이
   * 진행 중 핸드를 오염시키지 않는 것은 `entry.service.int-spec.ts`의
   * 늦은 참가 테스트가 잡는다. 여기 남는 값은 **그 둘이 한 대회 위에서
   * 조립됐을 때도 장부가 서는가**이고, 실제 레이스에 대한 회귀 방어는
   * 별도 티켓이 맡는다.
   */
  it('핸드 도중 착석과 플레이어 액션이 같이 와도 둘 다 남는다', async () => {
    const players = ['p1', 'p2', 'p3'];
    h = await setupTournament(players, {});
    const seated = players.length * SCENARIO.startStack;
    await payAll(h, ['b1']);
    const [otp] = await otpsOf(h, ['b1']);

    await h.dealer.startPreFlop(h.tournamentId, h.tableId);
    const before = await checkInvariants(h, '프리플랍 시작', seated);
    const turn = h.turnId(before)!;

    // 둘 다 같은 스냅샷을 정당하게 바꾼다. 스냅샷은 Redis 키 하나를
    // 통째로 read-modify-SET하므로, 락이 없으면 늦게 쓴 쪽이 앞의 것을
    // 통째로 덮는다 — 남은 상태는 그 자체로는 일관돼 보이지만 둘 중
    // 하나의 효과가 사라진다.
    const results = await Promise.allSettled([
      h.entry.enterSeat(h.tournamentId, { otp, tableId: h.tableId, seatIndex: 5 }),
      h.playsync.handleAction(turn, h.tableId, { action: 'CALL' }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    expect(`성공 ${ok.length}`).toBe('성공 2');

    // 착석이 남았는가 — 칩 총량이 새 참가자만큼 늘고, 비트맵과 스냅샷이
    // 일치하고(`checkInvariants` 6번), 그 사람이 5번 자리에 있다.
    const after = await checkInvariants(h, '착석+액션 동시', seated + SCENARIO.startStack);
    expect(`b1 좌석 ${h.seatOf(after, 'b1')}`).toBe('b1 좌석 5');

    // 액션이 남았는가 — 콜한 사람의 베팅액이 현재 베팅과 같아졌다.
    // 프리플랍 첫 행동자는 아직 빅블라인드를 맞추지 않은 상태라, 이 값이
    // 그대로면 그 사람의 CALL이 통째로 사라진 것이다.
    const actor = after.players[h.seatOf(after, turn)]!;
    expect(`행동자 베팅 ${actor.bet}`).toBe(`행동자 베팅 ${before.currentBet}`);
  });

  it('딜러가 핸드 시작을 동시에 두 번 눌러도 블라인드는 한 번만 나간다', async () => {
    const players = ['p1', 'p2', 'p3'];
    h = await setupTournament(players, {});
    const total = players.length * SCENARIO.startStack;

    const results = await Promise.allSettled([
      h.dealer.startPreFlop(h.tournamentId, h.tableId),
      h.dealer.startPreFlop(h.tournamentId, h.tableId),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(`성공 ${ok.length}`).toBe('성공 1');
    expect(`실패 ${failed.length}`).toBe('실패 1');
    expect(`거절 ${(failed[0].reason as Error).message}`)
      .toBe('거절 대기 상태가 아닙니다.');

    // 하네스 기본 블라인드는 sb=100, ante=false다. 엔진이 bb를 sb*2로 놓으므로
    // (`table-engine.ts:433,436`) 한 번 시작하면 팟은 정확히 300이다.
    // 두 번 나가면 600 — 칩 총량은 그대로라 이 단언만이 그것을 잡는다.
    const state = await checkInvariants(h, '중복 시작 후', total);
    expect(`팟 ${state.pot}`).toBe('팟 300');
  });
});
