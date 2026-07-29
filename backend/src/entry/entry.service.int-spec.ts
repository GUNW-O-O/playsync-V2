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

  it('같은 좌석을 동시에 노리면 한 명만 앉는다', async () => {
    await participate('u1', '00000001');
    await participate('u2', '00000002');

    const results = await Promise.allSettled([
      service.enterSeat(TOURNAMENT, { otp: '00000001', tableId: TABLE, seatIndex: 2 }),
      service.enterSeat(TOURNAMENT, { otp: '00000002', tableId: TABLE, seatIndex: 2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tablePlayer.count({ where: { tableId: TABLE, seatPosition: 2 } })).toBe(1);
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
