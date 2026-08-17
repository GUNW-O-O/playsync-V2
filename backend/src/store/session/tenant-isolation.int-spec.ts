import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GameType, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../../test/helpers/redis';
import { SessionService } from './session.service';

/**
 * 상점 경계(테넌트 분리).
 *
 * `assertTournamentOwnership`을 지나는 조작(시작·취소·테이블·좌석 해제·
 * 재발급·좌석 조회)은 이미 남의 대회를 거절한다. 여기서 보는 것은 **그 검사가
 * 아예 없던 세 자리**다 — 대회 생성·목록 조회·종료. 셋 다 상점 id나 대회 id를
 * 요청에서 그대로 받아 썼고, 호출자가 그 상점 주인인지 묻지 않았다.
 *
 * 목을 쓰지 않는 이유는 검사의 근거가 DB의 `Store.ownerId` 관계 자체라서다.
 * 목으로 두면 "무엇을 조회했는가"만 보게 되고, 정작 남의 행에 닿는지는 안 본다.
 */
describe('상점 경계 — 남의 상점을 건드릴 수 없다', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;

  /** 상점 A(공격자 쪽 호출자)와 상점 B(피해자). */
  let ownerA: string;
  let storeA: string;
  let blindA: string;
  let ownerB: string;
  let storeB: string;
  let blindB: string;

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

    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    const a = await makeStore('A');
    ownerA = a.ownerId;
    storeA = a.storeId;
    blindA = a.blindId;

    const b = await makeStore('B');
    ownerB = b.ownerId;
    storeB = b.storeId;
    blindB = b.blindId;
  });

  async function makeStore(label: string) {
    const owner = await prisma.user.create({
      data: { nickname: `owner-${label}`, password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: `상점 ${label}`, ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: `구조 ${label}`,
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    return { ownerId: owner.id, storeId: store.id, blindId: blind.id };
  }

  const makeDto = (storeId: string, blindId: string): CreateTournamentDto => ({
    name: '대회',
    type: GameType.TOURNAMENT,
    storeId,
    blindId,
    startStack: 10000,
    entryFee: 1000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [{ place: 1, percent: 100 }],
  });

  describe('createSession', () => {
    it('남의 상점 id로는 대회를 만들 수 없다', async () => {
      await expect(
        sessionService.createSession(makeDto(storeB, blindB), ownerA),
      ).rejects.toThrow(ForbiddenException);

      await expect(prisma.tournament.count({ where: { storeId: storeB } })).resolves.toBe(0);
    });

    it('본인 상점이면 만들어진다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);

      await expect(prisma.tournament.count({ where: { storeId: storeA } })).resolves.toBe(1);
    });

    // 아래 둘은 **검사가 하나로는 부족하다**는 것을 보인다. 상점 id 하나만
    // 확인하면 통과하는 입력이라, 두 값이 어긋나는 경우를 따로 먹인다.
    it('본인 상점 대회에 남의 블라인드 구조를 붙일 수 없다', async () => {
      await expect(
        sessionService.createSession(makeDto(storeA, blindB), ownerA),
      ).rejects.toThrow(ForbiddenException);
    });

    it('본인 상점 대회를 만들며 남의 상점에 블라인드 구조를 심을 수 없다', async () => {
      const dto = makeDto(storeA, undefined as unknown as string);
      delete (dto as { blindId?: string }).blindId;

      await expect(
        sessionService.createSession(dto, ownerA, {
          name: '심어진 구조',
          storeId: storeB,
          structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(prisma.blindStructure.count({ where: { storeId: storeB } })).resolves.toBe(1);
    });
  });

  describe('getStoreAllSessions', () => {
    it('남의 상점 대회 목록은 볼 수 없다', async () => {
      await sessionService.createSession(makeDto(storeB, blindB), ownerB);

      await expect(sessionService.getStoreAllSessions(storeB, ownerA)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('본인 상점 목록은 그대로 나온다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);

      const sessions = await sessionService.getStoreAllSessions(storeA, ownerA);

      expect(sessions).toHaveLength(1);
    });
  });

  describe('completeSession', () => {
    it('남의 대회는 종료할 수 없다 — 상금 지급이 걸린 경로다', async () => {
      await sessionService.createSession(makeDto(storeB, blindB), ownerB);
      const target = await prisma.tournament.findFirstOrThrow({ where: { storeId: storeB } });

      await expect(sessionService.completeSession(target.id, ownerA)).rejects.toThrow(
        ForbiddenException,
      );

      const after = await prisma.tournament.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.status).toBe(target.status);
    });

    it('본인 대회는 종료된다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);
      const mine = await prisma.tournament.findFirstOrThrow({ where: { storeId: storeA } });

      await expect(sessionService.completeSession(mine.id, ownerA)).resolves.not.toThrow();
    });
  });
});
