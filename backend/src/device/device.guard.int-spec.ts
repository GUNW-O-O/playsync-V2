import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import { DEVICE_UNREGISTERED_MESSAGE } from '@playsync/contract';
import { PrismaService } from 'src/prisma/prisma.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { signDeviceToken } from './device-token';
import { DeviceGuard } from './device.guard';

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('DeviceGuard', () => {
  let prisma: PrismaClient;
  let guard: DeviceGuard;
  const jwt = new JwtService({ secret: 'device-guard-secret' });
  const token = (storeId: string, ver = 0) => signDeviceToken(jwt, { storeId, ver });

  beforeAll(() => {
    prisma = createTestPrisma();
    guard = new DeviceGuard(prisma as unknown as PrismaService, jwt);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.user.create({ data: { id: 'o', nickname: 'o', password: 'x', role: Role.STORE_ADMIN } });
    await prisma.store.create({ data: { id: 'store-a', name: 'A', ownerId: 'o' } });
    await prisma.store.create({ data: { id: 'store-b', name: 'B', ownerId: 'o' } });
    await prisma.blindStructure.create({ data: { id: 'blind', name: 'b', storeId: 'store-a', structure: [] } });
    await prisma.tournament.create({
      data: { id: 'trn-a', name: 'a', blindId: 'blind', storeId: 'store-a', dealerOtpHash: 'x' },
    });
  });

  afterAll(async () => {
    await closeTestPrisma(prisma);
  });

  async function rejectsWith(req: Record<string, unknown>) {
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(
      new UnauthorizedException(DEVICE_UNREGISTERED_MESSAGE),
    );
  }

  it('경로의 대회가 토큰의 상점 것이면 통과하고 req.device를 채운다', async () => {
    const req: Record<string, any> = { headers: { 'x-device-token': token('store-a') }, params: { id: 'trn-a' } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.device.storeId).toBe('store-a');
  });

  it('본문의 tournamentId도 읽는다(/dealer/auth)', async () => {
    const req = { headers: { 'x-device-token': token('store-a') }, params: {}, body: { tournamentId: 'trn-a' } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
  });

  it('토큰이 없으면 401', () => rejectsWith({ headers: {}, params: { id: 'trn-a' } }));

  it('위조 토큰이면 401', () => rejectsWith({ headers: { 'x-device-token': 'garbage' }, params: { id: 'trn-a' } }));

  it('남의 상점 토큰이면 401', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-b') }, params: { id: 'trn-a' } }));

  it('없는 대회도 같은 401 — 대회 id를 훑을 수 없다', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-a') }, params: { id: 'nope' } }));

  it('해제된 버전은 401', async () => {
    const old = token('store-a', 0);
    await prisma.store.update({ where: { id: 'store-a' }, data: { deviceTokenVersion: 1 } });
    await rejectsWith({ headers: { 'x-device-token': old }, params: { id: 'trn-a' } });
  });

  it('본문의 tournamentId가 문자열이 아니면 401 — ValidationPipe 앞이다', () =>
    rejectsWith({ headers: { 'x-device-token': token('store-a') }, params: {}, body: { tournamentId: { not: 'x' } } }));
});
