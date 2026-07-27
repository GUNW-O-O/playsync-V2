import { GameType, PrismaClient } from '@prisma/client';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import Redis from 'ioredis';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../../test/helpers/redis';
import { SessionService } from './session.service';

/**
 * OTP 해시 전환의 통합 검증.
 *
 * 단위 스펙(`session.service.spec.ts`)은 prisma를 목으로 두고 트랜잭션 안의
 * `data`만 본다. 여기서는 실제로 저장된 컬럼을 읽어, 응답에는 평문이 한 번만
 * 실리고 DB에는 해시만 남는지를 확인한다.
 */
describe('SessionService.createSession — OTP 해시 통합', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;
  let storeId: string;
  let blindId: string;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);

    const redisService = new RedisService(redis);
    sessionService = new SessionService(prisma as unknown as PrismaService, redisService);

    const owner = await prisma.user.create({
      data: { nickname: 'owner', password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: '테스트 상점', ownerId: owner.id },
    });
    storeId = store.id;
    const blind = await prisma.blindStructure.create({
      data: {
        name: '기본 구조',
        storeId,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    blindId = blind.id;
  });

  const makeCreateDto = (): CreateTournamentDto => ({
    name: '테스트 대회',
    type: GameType.TOURNAMENT,
    storeId,
    blindId,
    startStack: 10000,
    entryFee: 1000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [{ place: 1, percent: 100 }],
  });

  it('대회를 만들면 평문 OTP는 반환에만 있고 DB에는 해시만 남는다', async () => {
    const created = await sessionService.createSession(makeCreateDto());

    expect(created.dealerOtp).toMatch(/^[0-9]{6}$/);

    const row = await prisma.tournament.findUniqueOrThrow({
      where: { id: created.id },
      select: { dealerOtpHash: true },
    });

    // 해시가 원본을 담고 있으면 저장한 의미가 없다.
    expect(row.dealerOtpHash).not.toContain(created.dealerOtp);
    expect(row.dealerOtpHash.startsWith('$2')).toBe(true);
  });

  it('대회 조회 응답에는 OTP도 해시도 실리지 않는다', async () => {
    const created = await sessionService.createSession(makeCreateDto());

    const fetched = await sessionService.getGameSession(created.id);

    expect(fetched).not.toHaveProperty('dealerOtp');
    expect(fetched).not.toHaveProperty('dealerOtpHash');
  });

  /**
   * 조회(getGameSession 등)만 막으면 충분하지 않다. `PATCH /store/sessions/:id`와
   * `PATCH /store/sessions/:id/start`는 각각 updateSession·startSession의
   * 반환값을 컨트롤러가 그대로 응답으로 내보낸다(session.controller.ts:28,33).
   * 이 두 쓰기 경로가 각자 `tournament.update()`를 부르므로, getGameSession의
   * omit과는 별개로 여기도 omit이 있어야 한다.
   */
  describe('쓰기 경로도 해시를 담아 보내지 않는다', () => {
    it('대회 시작 응답에 해시가 없다', async () => {
      const created = await sessionService.createSession(makeCreateDto());

      // 시작 최소 인원 게이트를 우회한다 — 여기서 보는 것은 게임 시작
      // 로직이 아니라 응답에 해시가 실리는지 여부다.
      process.env.MIN_PLAYERS_TO_START = '0';
      try {
        const started = await sessionService.startSession(created.id);
        expect(started).not.toHaveProperty('dealerOtp');
        expect(started).not.toHaveProperty('dealerOtpHash');
      } finally {
        delete process.env.MIN_PLAYERS_TO_START;
      }
    });

    it('대회 수정 응답에 해시가 없다', async () => {
      const created = await sessionService.createSession(makeCreateDto());

      const updated = await sessionService.updateSession(created.id, {
        name: '이름 변경',
      });

      expect(updated).not.toHaveProperty('dealerOtp');
      expect(updated).not.toHaveProperty('dealerOtpHash');
    });
  });
});
