import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { PrismaService } from 'src/prisma/prisma.service';
import { HeartbeatService } from './heartbeat.service';

/**
 * `beatOnce`가 실제로 DB에 남기는지, 그리고 **Redis ping이 실패하면 찍지
 * 않는지**를 확인한다. ping 조건이 이 서비스의 유일한 존재 이유다 — 시각만
 * 찍으면 "서버는 살아 있고 Redis만 죽은" 구간을 다운타임으로 못 잡는다.
 */
describe('HeartbeatService', () => {
  let prisma: PrismaClient;
  let redis: Redis;

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
  });

  it('Redis ping이 실패하면 하트비트를 찍지 않는다', async () => {
    const before = await prisma.serverHeartbeat.findUnique({ where: { id: 'singleton' } });
    const broken = { ping: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const svc = new HeartbeatService(prisma as unknown as PrismaService, broken);

    expect(await svc.beatOnce()).toBe(false);
    const after = await prisma.serverHeartbeat.findUnique({ where: { id: 'singleton' } });
    expect(`행 ${after?.beatAt.getTime() ?? 'none'}`).toBe(`행 ${before?.beatAt.getTime() ?? 'none'}`);
  });

  it('ping이 성공하면 upsert로 찍는다 (최초에는 행을 만든다)', async () => {
    const svc = new HeartbeatService(prisma as unknown as PrismaService, redis);

    const before = await prisma.serverHeartbeat.findUnique({ where: { id: 'singleton' } });
    expect(before).toBeNull();

    expect(await svc.beatOnce()).toBe(true);
    const firstBeat = await prisma.serverHeartbeat.findUniqueOrThrow({ where: { id: 'singleton' } });

    // 두 번째 호출은 새 행이 아니라 같은 행을 갱신해야 한다.
    await new Promise((r) => setTimeout(r, 10));
    expect(await svc.beatOnce()).toBe(true);
    const secondBeat = await prisma.serverHeartbeat.findUniqueOrThrow({ where: { id: 'singleton' } });

    expect(await prisma.serverHeartbeat.count()).toBe(1);
    expect(secondBeat.beatAt.getTime()).toBeGreaterThan(firstBeat.beatAt.getTime());
  });
});
