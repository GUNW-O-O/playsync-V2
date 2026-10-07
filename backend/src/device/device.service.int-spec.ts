import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { verifyDeviceToken } from './device-token';
import { DeviceService } from './device.service';

describe('DeviceService', () => {
  let prisma: PrismaClient;
  let service: DeviceService;
  const jwt = new JwtService({ secret: 'device-int-secret' });

  beforeAll(() => {
    prisma = createTestPrisma();
    service = new DeviceService(prisma as unknown as PrismaService, jwt);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.user.create({ data: { id: 'owner-a', nickname: 'owner-a', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.user.create({ data: { id: 'owner-b', nickname: 'owner-b', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.store.create({ data: { id: 'store-a', name: 'A', ownerId: 'owner-a' } });
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  it('소유자는 등록하고, 토큰에 상점과 현재 버전이 실린다', async () => {
    await prisma.store.update({ where: { id: 'store-a' }, data: { deviceTokenVersion: 4 } });
    const { deviceToken } = await service.register('store-a', 'owner-a');
    const payload = verifyDeviceToken(jwt, deviceToken);
    expect(`${payload?.storeId}/${payload?.ver}`).toBe('store-a/4');
  });

  it('남의 점주는 등록할 수 없다', async () => {
    await expect(service.register('store-a', 'owner-b')).rejects.toThrow(ForbiddenException);
  });

  it('없는 상점은 403이다 — 존재를 가르지 않는다', async () => {
    await expect(service.register('no-store', 'owner-a')).rejects.toThrow(ForbiddenException);
  });

  it('해제는 버전을 하나 올린다', async () => {
    await service.revokeAll('store-a', 'owner-a');
    const store = await prisma.store.findUniqueOrThrow({ where: { id: 'store-a' } });
    expect(`버전 ${store.deviceTokenVersion}`).toBe('버전 1');
  });

  it('남의 점주는 해제할 수 없고, 버전도 안 움직인다', async () => {
    await expect(service.revokeAll('store-a', 'owner-b')).rejects.toThrow(ForbiddenException);
    const store = await prisma.store.findUniqueOrThrow({ where: { id: 'store-a' } });
    expect(`버전 ${store.deviceTokenVersion}`).toBe('버전 0');
  });
});
