import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { isClosedTournament } from 'src/store/session/tournament-status';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) { };

  async findByNickname(nickname: string) {
    return this.prisma.user.findUnique({ where: { nickname } });
  }

  /**
   * uuid 단건 조회. **없는 유저를 거르는 유일한 자리다.**
   *
   * 예전에는 `await`가 빠져 있어 `if (!user)`가 도달 불가였고(Promise는 항상
   * truthy다), 실제로 막는 것은 호출부 둘이 각자 들고 있던 null 검사였다.
   * `await`를 채우면서 그 둘을 지웠다 — 검사가 둘이면 한쪽만 고쳐지는 날이
   * 온다. 호출부(`UserService.paymentPoint` · `PaymentService.joinSession`)는
   * 이 함수가 던진다는 것에 기댄다.
   */
  async findByUUID(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id }
    });
    if (!user) {
      throw new NotFoundException('UUID 조회 실패');
    }
    return user;
  }

  async paymentPoint(tx: any, userId: string, tournamentId: string, sessionName: string, amount: number) {
    await this.findByUUID(userId);

    await tx.user.update({
      where: { id: userId },
      data: { points: { decrement: amount } }
    });
    await tx.pointTransaction.create({
      data: {
        userId,
        amount: -amount,
        type: 'BUY_IN',
        tournamentId: tournamentId,
        description: `${sessionName} 바이인`
      }
    })
  }

  /**
   * 내가 참여한 대회 목록. 마이페이지가 쓴다.
   *
   * **참가 OTP를 읽는 유일한 곳이다.** `PrismaService`가 이 필드를 기본으로
   * 감추므로 여기서만 `omit: { playerOtp: false }`를 준다. 다른 경로가
   * 이 값을 실으려면 같은 한 줄을 명시해야 하고, 그 순간 리뷰에 걸린다.
   *
   * 끝난 대회의 OTP는 쓸 데가 없다. 목록에 남겨 두면 유출 표면만 넓어지므로
   * 응답에서 뺀다. `FINISHED`만 제외하고 나머지는 전부 보여준다 — 상태를
   * 나열해서 살아있는 것만 고르면, 나중에 상태가 하나 늘 때 조용히
   * 빠진다(`SYNCING`이 실제로 그런 경우였다: 테이블 이동 중인 참가자가
   * 새 테이블에 재입장하려면 바로 이 OTP가 필요하다).
   *
   * `userId`가 비어 있으면(예: 딜러 토큰이 가드를 뚫고 들어온 경우)
   * `where: { userId: undefined }`가 필터를 통째로 지운다 — 이 스키마는
   * `strictUndefinedChecks`가 없어 타입도 이를 막지 못한다. 컨트롤러의
   * 가드가 우회되더라도 여기서 한 번 더 막는다 — 서비스를 직접 부르는
   * 통합 테스트나 다른 호출부는 라우트 가드를 거치지 않는다.
   */
  async getMyParticipations(userId: string) {
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedException('유효한 사용자가 아닙니다.');
    }

    const rows = await this.prisma.tournamentParticipation.findMany({
      where: { userId },
      omit: { playerOtp: false },
      include: {
        tournament: {
          select: { id: true, name: true, status: true, entryFee: true, startedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(row => ({
      ...row,
      playerOtp: isClosedTournament(row.tournament.status) ? null : row.playerOtp,
    }));
  }
}
