import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DEVICE_UNREGISTERED_MESSAGE } from '@playsync/contract';
import { PrismaService } from 'src/prisma/prisma.service';
import { deviceTokenFrom, verifyDeviceToken } from './device-token';

/**
 * 등록된 매장 태블릿만 지나간다(T112). `/enter`와 `/dealer/auth`에 건다.
 *
 * **상점 대조를 서비스가 아니라 여기서 한다.** 문이 핸들러보다 먼저 서므로
 * 두 순서가 구조로 보장된다 — OTP 조회보다 먼저(뒤면 남의 상점 기기가 「그
 * OTP가 유효하다」를 응답 차이로 읽는다), `OtpAttempts.reserveAttempt`보다
 * 먼저(뒤면 남의 상점 기기가 그 대회의 딜러 잠금 슬롯을 태운다).
 *
 * 없는 대회 · 남의 상점 · 해제된 버전 · 위조를 전부 같은 401로 내린다.
 * 가르면 대회 id를 훑을 수 있다.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const device = verifyDeviceToken(this.jwt, deviceTokenFrom(req));

    // `/enter`는 경로의 `:id`, `/dealer/auth`는 본문의 `tournamentId`다. 본문은
    // 아직 ValidationPipe를 안 지났으므로 문자열이 아니면 없는 대회로 친다.
    const tournamentId = req.params?.id ?? req.body?.tournamentId;

    if (device && typeof tournamentId === 'string') {
      const tournament = await this.prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: { storeId: true, store: { select: { deviceTokenVersion: true } } },
      });
      if (tournament?.storeId === device.storeId && tournament.store.deviceTokenVersion === device.ver) {
        req.device = device;
        return true;
      }
    }
    throw new UnauthorizedException(DEVICE_UNREGISTERED_MESSAGE);
  }
}
