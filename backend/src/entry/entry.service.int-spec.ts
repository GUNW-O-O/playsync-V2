import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, PlayerStatus, TournamentStatus } from '@prisma/client';
import Redis from 'ioredis';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { EntryService } from './entry.service';

describe('EntryService.enterSeat', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisService: RedisService;
  let service: EntryService;

  const TOURNAMENT = 'entry-tournament-1';
  const TABLE = 'entry-table-1';
  const OTHER_TABLE = 'entry-table-2';

  /** 참가 하나를 만들고 그 OTP를 돌려준다. */
  async function participate(userId: string, otp: string, tournamentId = TOURNAMENT) {
    await prisma.user.create({ data: { id: userId, nickname: userId, password: 'x' } });
    await prisma.tournamentParticipation.create({
      data: { userId, tournamentId, playerOtp: otp, status: PlayerStatus.WAITING },
    });
    return otp;
  }

  /** `Table.dealerId`가 필수라 대회마다 딜러 세션이 하나 있어야 한다. */
  async function seedTournament(id: string, status: TournamentStatus, tableIds: string[]) {
    await prisma.tournament.create({
      data: {
        id, name: id, blindId: 'entry-blind', storeId: 'entry-store',
        dealerOtpHash: 'unused', entryFee: 1000, startStack: 10000,
        status, isRegistrationOpen: true,
      },
    });
    const dealerSession = await prisma.dealerSession.create({ data: { tournamentId: id } });
    for (const [order, tableId] of tableIds.entries()) {
      await prisma.table.create({
        data: {
          id: tableId, tournamentId: id, tableOrder: order + 1,
          dealerId: dealerSession.id,
        },
      });
    }
  }

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    redisService = new RedisService(redis);
    service = new EntryService(
      prisma as unknown as PrismaService,
      redisService,
      new JwtService({ secret: 'entry-spec-secret' }),
      new EventEmitter2(),
    );
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    await prisma.user.create({
      data: { id: 'entry-owner', nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    await prisma.store.create({ data: { id: 'entry-store', name: '상점', ownerId: 'entry-owner' } });
    await prisma.blindStructure.create({
      data: {
        id: 'entry-blind', name: '기본', storeId: 'entry-store',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 600 }],
      },
    });
    await seedTournament(TOURNAMENT, TournamentStatus.PENDING, [TABLE, OTHER_TABLE]);
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
    await redis.quit();
  });

  async function snapshot(tableId = TABLE): Promise<TableState | null> {
    return await redisService.getSnapShot(tableId);
  }

  it('OTP가 맞으면 좌석이 확정되고 토큰이 나온다', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 3,
    });

    expect(accessToken).toEqual(expect.any(String));

    const row = await prisma.tablePlayer.findFirstOrThrow({ where: { userId: 'u1' } });
    expect(row.seatPosition).toBe(3);
    expect(row.currentStack).toBe(10000);

    const state = await snapshot();
    expect(state!.players[3]).toMatchObject({ id: 'u1', seatIndex: 3, stack: 10000 });

    const participation = await prisma.tournamentParticipation.findFirstOrThrow({
      where: { userId: 'u1' },
    });
    expect(participation.status).toBe(PlayerStatus.PLAYING);
  });

  it('좌석 토큰의 sub가 스냅샷의 플레이어 id와 같다 — 게이트웨이 좌석 대조의 근거', async () => {
    await participate('u1', '00000001');

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 0,
    });

    const payload = new JwtService({ secret: 'entry-spec-secret' }).verify(accessToken);
    const state = await snapshot();
    expect(state!.players.some((p) => p?.id === payload.sub)).toBe(true);
    expect(payload).toMatchObject({
      tournamentId: TOURNAMENT, tableId: TABLE, seatIndex: 0, role: 'PLAYER',
    });
  });

  it('틀린 OTP는 401이다', async () => {
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '99999999', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('없는 대회도 같은 401이다 — 존재하는 대회 id를 훑을 수 없어야 한다', async () => {
    await expect(
      service.enterSeat('no-such-tournament', { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('다른 대회의 OTP는 통하지 않는다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, []);
    await participate('u1', '00000001', 'entry-tournament-2');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('끝난 대회는 403이다', async () => {
    await participate('u1', '00000001');
    await prisma.tournament.update({
      where: { id: TOURNAMENT }, data: { status: TournamentStatus.FINISHED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('탈락한 참가자는 다시 앉지 못한다', async () => {
    await participate('u1', '00000001');
    await prisma.tournamentParticipation.updateMany({
      where: { userId: 'u1' }, data: { status: PlayerStatus.ELIMINATED },
    });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('이 대회에 속하지 않은 테이블은 403이다', async () => {
    await seedTournament('entry-tournament-2', TournamentStatus.PENDING, ['foreign-table']);
    await participate('u1', '00000001');

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: 'foreign-table', seatIndex: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('이미 다른 자리에 앉아 있으면 409다 — 이동은 T29다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await expect(
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: OTHER_TABLE, seatIndex: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('같은 좌석에 다시 넣으면 토큰만 새로 나오고 좌석은 하나다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
  });

  it('재입장이 진행 중인 핸드의 상태를 덮지 않는다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    live.players[1]!.bet = 500;
    live.players[1]!.totalContributed = 500;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    const after = (await snapshot())!;
    expect(after.players[1]).toMatchObject({ bet: 500, totalContributed: 500 });
  });

  it('DB에는 있는데 스냅샷에서 사라진 좌석을 재입장이 되살린다', async () => {
    await participate('u1', '00000001');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    // DB를 쓰고 스냅샷을 쓰기 전에 죽은 상태를 그대로 만든다.
    const broken = (await snapshot())!;
    broken.players[1] = null;
    await redisService.saveSnapShot(TABLE, broken);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 1 });

    expect((await snapshot())!.players[1]).toMatchObject({ id: 'u1' });
  });

  it('핸드 도중에 앉으면 이번 핸드는 폴드 상태로 들어간다 — 늦은 참가', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 0 });

    const live = (await snapshot())!;
    live.phase = GamePhase.FLOP;
    await redisService.saveSnapShot(TABLE, live);

    await service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 4 });

    expect((await snapshot())!.players[4]).toMatchObject({ id: 'u2', hasFolded: true });
  });

  it('같은 좌석을 동시에 노리면 한 명만 앉고 진 쪽은 409를 받는다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { tableId: TABLE, seatPosition: 2 } })).toBe(1);

    // T11이 지키던 것: 진 쪽이 500이 아니라 409를 받는다. 프론트가 "다른 자리를
    // 고르세요"와 "서버가 죽었다"를 구분하려면 이 타입이 정확해야 한다. 좌석
    // describe를 지우면서(T28 Task 3) 이 어서션 없이 통과가 남을 뻔했다 —
    // `claimSeat`의 catch가 `ConflictException`을 안 던지고 원본 Prisma
    // 에러를 그대로 흘려도 위 두 줄만으로는 초록이었다(T28 리뷰 finding 1).
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
  });

  it('다른 좌석에 동시에 앉으면 서로를 지우지 않는다', async () => {
    for (const [i, id] of ['u1', 'u2', 'u3'].entries()) {
      await participate(id, String(i + 1).padStart(8, '0'));
    }

    await Promise.all(
      ['u1', 'u2', 'u3'].map((_, i) =>
        service.enterSeat(TOURNAMENT, {
          otp: String(i + 1).padStart(8, '0'), tableId: TABLE, seatIndex: i,
        }),
      ),
    );

    const state = (await snapshot())!;
    expect(state.players.filter(Boolean)).toHaveLength(3);
  });

  /**
   * 리뷰 finding 1: 같은 OTP가 두 테이블에서 몇 ms 안에 동시에 들어오면,
   * 사전 체크(`tablePlayer.findFirst`)는 둘 다 통과시킨다 — 테이블마다 락이
   * 따로라 서로 막지 않는다. `@@unique([tournamentId, userId])`가 없으면
   * 둘 다 커밋되어 참가 하나가 좌석 둘을 갖는다.
   */
  it('같은 유저가 서로 다른 테이블을 동시에 노리면 한 곳에만 앉는다', async () => {
    await participate('u1', '00000001');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: OTHER_TABLE, seatIndex: 3 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
  });

  /**
   * T28 리뷰 3라운드 finding 2: `payment.service.ts`는 이미 이 보증을
   * 스텁으로 검증한 적이 있었다(트랜잭션 커밋이 실패해도 Redis에 유령 착석이
   * 남지 않는다 — `docs/fixlist.md:376`). Task 3가 그 describe를 지우면서
   * "entry.service.int-spec.ts가 같은 것을 진짜 제약 위에서 본다"고 했지만,
   * 그 주장을 뒷받침하는 테스트가 실제로는 없었다.
   *
   * 스텁 없이 진짜로 커밋을 실패시킨다: 같은 유저가 두 테이블을 동시에
   * 노리면 `@@unique([tournamentId, userId])`가 진 쪽의 `tablePlayer.create`를
   * P2002로 되돌린다 — 위의 "한 곳에만 앉는다" 테스트와 같은 경합이다. 그
   * 테스트가 안 보는 것: 진 쪽이 노렸던 좌석에 스냅샷이나 비트맵 흔적이
   * 조금이라도 남는가. `claimSeat`은 스냅샷·비트맵 쓰기를 트랜잭션 **밖**에
   * 둬서 막고 있는데, 그 배치가 우연이 아니라 지켜야 할 계약이라는 것을
   * 여기서 고정한다. 누군가 "원자적으로 만들자"며 그 쓰기를 트랜잭션 안으로
   * 옮기면(자연스러워 보이는 리팩터다), 트랜잭션이 실패하기 전에 실행된
   * Redis 쓰기는 롤백되지 않고 살아남는다 — 이 테스트가 그걸 잡아야 한다.
   */
  it('두 테이블 경합에서 진 쪽이 노린 좌석에는 스냅샷도 비트맵도 남지 않는다', async () => {
    await participate('u1', '00000001');
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);
    await redisService.setSeatBitmap(TOURNAMENT, OTHER_TABLE);

    const attempts = [
      { tableId: TABLE, seatIndex: 2 },
      { tableId: OTHER_TABLE, seatIndex: 3 },
    ];
    const results = await Promise.allSettled(
      attempts.map((a) =>
        service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: a.tableId, seatIndex: a.seatIndex }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loserIndex = results.findIndex((r) => r.status === 'rejected');
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect((results[loserIndex] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const winnerIndex = loserIndex === 0 ? 1 : 0;
    const loser = attempts[loserIndex];
    const winner = attempts[winnerIndex];

    // 이긴 쪽의 좌석은 정상적으로 채워진다.
    const winnerState = await snapshot(winner.tableId);
    expect(winnerState?.players[winner.seatIndex]).toMatchObject({ id: 'u1' });

    // 진 쪽이 노렸던 좌석에는 스냅샷도(테이블 자체가 비어 있거나, 그 자리가
    // null이거나) 비트맵도 흔적이 없어야 한다.
    const loserState = await snapshot(loser.tableId);
    expect(loserState?.players[loser.seatIndex] ?? null).toBeNull();
    const bitmap = await redis.hget(`tournament:${TOURNAMENT}:seat`, `table:${loser.tableId}`);
    expect(bitmap?.[loser.seatIndex]).toBe('0');
  });

  /**
   * 리뷰 2라운드 finding: 탈락 처리가 `TablePlayer` 행을 지운 뒤, 다음 핸드
   * 준비(`initTable`)가 스냅샷 자리를 비우기 전 사이의 창을 흉내 낸다. DB에는
   * 그 좌석의 행이 없지만 스냅샷은 여전히 예전 점유자를 가리키는 상태다.
   * 이 상태에서 새 참가자가 그 좌석을 노리면, DB가 좌석을 내줬으니 스냅샷의
   * 낡은 값을 예외 없이 고쳐 써야 한다 — 예외를 던지면 DB에는 이미 새
   * 참가자의 좌석이 커밋된 채로 클라이언트만 실패를 보고, 재시도해도
   * `alreadySeated`라 트랜잭션 없이 같은 예외가 반복돼 영구히 좌석 없는
   * PLAYING으로 묶인다.
   */
  it('스냅샷에 낡은 다른 참가자가 남아 있어도 DB가 비어 있으면 좌석을 되찾는다', async () => {
    await participate('u1', '00000001');
    await participate('ghost', '00000099');
    // ghost가 먼저 앉아 스냅샷에 자리를 남긴다.
    await service.enterSeat(TOURNAMENT, { otp: '00000099', tableId: TABLE, seatIndex: 7 });

    // 탈락 처리를 흉내 낸다: DB 행만 지우고 스냅샷은 그대로 둔다
    // (eliminatePlayer가 지운 뒤 initTable이 비우기 전의 창).
    await prisma.tablePlayer.deleteMany({ where: { userId: 'ghost' } });

    const before = (await snapshot())!;
    expect(before.players[7]).toMatchObject({ id: 'ghost' });

    const { accessToken } = await service.enterSeat(TOURNAMENT, {
      otp: '00000001', tableId: TABLE, seatIndex: 7,
    });
    expect(accessToken).toEqual(expect.any(String));

    const row = await prisma.tablePlayer.findFirstOrThrow({ where: { userId: 'u1' } });
    expect(row.tableId).toBe(TABLE);
    expect(row.seatPosition).toBe(7);

    const after = (await snapshot())!;
    expect(after.players[7]).toMatchObject({ id: 'u1' });

    // 재시도(같은 요청을 한 번 더)해도 안전하다 — 이제 alreadySeated라
    // 트랜잭션은 건너뛰고, 스냅샷은 이미 우리 것이라 손대지 않는다.
    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 7 });
    expect(await prisma.tablePlayer.count({ where: { userId: 'u1' } })).toBe(1);
    expect((await snapshot())!.players[7]).toMatchObject({ id: 'u1' });
  });

  it('좌석 비트맵에 반영된다', async () => {
    await participate('u1', '00000001');
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);

    await service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 5 });

    const bitmap = await redis.hget(`tournament:${TOURNAMENT}:seat`, `table:${TABLE}`);
    expect(bitmap![5]).toBe('1');
  });
});
