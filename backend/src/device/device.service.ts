import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { signDeviceToken } from './device-token';

/**
 * 매장 태블릿 등록과 전체 해제(T112).
 *
 * 소유권 판정은 `SessionService`의 `assertStoreOwnership`과 같은 모양이다 —
 * 없는 상점과 남의 상점을 같은 403으로 내려 존재를 가르지 않는다.
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(storeId: string, ownerId: string): Promise<{ deviceToken: string }> {
    const store = await this.ownedStore(storeId, ownerId);
    return { deviceToken: signDeviceToken(this.jwt, { storeId, ver: store.deviceTokenVersion }) };
  }

  /** 이 상점의 기기 토큰을 전부 죽인다. 남은 태블릿은 다시 등록한다. */
  async revokeAll(storeId: string, ownerId: string): Promise<{ ok: true }> {
    await this.ownedStore(storeId, ownerId);
    await this.prisma.store.update({
      where: { id: storeId },
      data: { deviceTokenVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  private async ownedStore(storeId: string, ownerId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true, deviceTokenVersion: true },
    });
    if (!store || store.ownerId !== ownerId) {
      throw new ForbiddenException('본인의 매장이 아닙니다.');
    }
    return store;
  }
}
