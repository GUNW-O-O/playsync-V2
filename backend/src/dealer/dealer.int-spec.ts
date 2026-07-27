import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { GameType, PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { DealerService } from './dealer.service';
import { OtpAttempts } from './otp-attempts';

/**
 * 딜러 로그인의 해시 대조와 잠금.
 *
 * `dealer.service.int-spec.ts`는 딜러 경로의 동시성(락)을 본다. 여기는
 * 로그인 그 자체 — 해시 대조가 실제로 틀린 값을 걸러내는지, 그리고 잠금이
 * 대회 단위로 걸리고 성공하면 풀리는지를 본다. Redis(잠금 카운터)와
 * PostgreSQL(해시 저장) 둘 다 진짜라야 의미가 있다.
 */
describe('딜러 로그인', () => {
  const SECRET = 'test-only-not-a-real-secret';

  let prisma: PrismaClient;
  let redis: Redis;
  let queueConnection: Redis;
  let queue: Queue;
  let dealerService: DealerService;
  let sessionService: SessionService;
  let seq = 0;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
    queueConnection = createTestRedis({ maxRetriesPerRequest: null });
    queue = new Queue('player-timeout', { connection: queueConnection });
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit();
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);
    seq = 0;

    const prismaService = prisma as unknown as PrismaService;
    const redisService = new RedisService(redis);
    const emitter = new EventEmitter2();
    const playsync = new PlaysyncService(queue, redisService, prismaService, emitter);
    const otpAttempts = new OtpAttempts(redis);
    sessionService = new SessionService(prismaService, redisService);
    dealerService = new DealerService(
      queue,
      prismaService,
      redisService,
      playsync,
      new JwtService({ secret: SECRET }),
      otpAttempts,
    );
  });

  /** 대회 하나를 세우고 평문 OTP를 함께 돌려준다. */
  async function seedTournament() {
    seq += 1;
    const n = seq;

    const owner = await prisma.user.create({
      data: { nickname: `owner-${n}`, password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: `상점-${n}`, ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: `블라인드-${n}`,
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });

    const created = await sessionService.createSession({
      name: `대회-${n}`,
      type: GameType.TOURNAMENT,
      storeId: store.id,
      blindId: blind.id,
      startStack: 10000,
      entryFee: 1000,
      rebuyUntil: 5,
      isRegistrationOpen: true,
      prizePayouts: [{ place: 1, percent: 100 }],
    } as CreateTournamentDto);

    const table = await prisma.table.findFirstOrThrow({
      where: { tournamentId: created.id },
    });

    return { tournamentId: created.id, tableId: table.id, otp: created.dealerOtp };
  }

  it('맞는 OTP는 통과하고 틀린 OTP는 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);

    const result = await dealerService.loginDealer({ tournamentId, tableId, otp });
    expect(typeof result.accessToken).toBe('string');
  });

  it('5회 실패하면 맞는 OTP도 거부된다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    // 여기가 핵심이다. 잠금이 없으면 이 줄이 통과해 버린다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('잠금은 대회 단위다 — 다른 대회는 영향받지 않는다', async () => {
    const a = await seedTournament();
    const b = await seedTournament();

    for (let i = 0; i < 5; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId: a.tournamentId, tableId: a.tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    const result = await dealerService.loginDealer({
      tournamentId: b.tournamentId,
      tableId: b.tableId,
      otp: b.otp,
    });
    expect(typeof result.accessToken).toBe('string');
  });

  it('성공하면 실패 카운터가 지워진다', async () => {
    const { tournamentId, tableId, otp } = await seedTournament();

    for (let i = 0; i < 4; i++) {
      await expect(
        dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
      ).rejects.toThrow(UnauthorizedException);
    }

    await dealerService.loginDealer({ tournamentId, tableId, otp });

    // 카운터가 지워지지 않았다면 다음 실패 하나로 잠긴다.
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp: '000000' }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      dealerService.loginDealer({ tournamentId, tableId, otp }),
    ).resolves.toBeDefined();
  });
});
