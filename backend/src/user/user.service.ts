import { Injectable, NotFoundException } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) { };

  async findByNickname(nickname: string) {
    return this.prisma.user.findUnique({ where: { nickname } });
  }

  async findByUUID(id: string) {
    const user = this.prisma.user.findUnique({
      where: { id }
    });
    if (!user) {
      throw new NotFoundException('UUID 조회 실패');
    }
    return user;
  }

  async paymentPoint(tx: any, userId: string, tournamentId: string, sessionName: string, amount: number) {
    const user = await this.findByUUID(userId);
    if (!user) throw new NotFoundException('유저를 찾을 수 없습니다');

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

  // 임시 포인트 추가 메소드
  async addPoint(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { points: { increment: 10000 } }
    })
    return await this.prisma.user.findUnique({ where: { id: userId } });
  }

  /**
   * 내가 참여한 대회 목록. 마이페이지가 쓴다.
   *
   * **참가 OTP를 읽는 유일한 곳이다.** `PrismaService`가 이 필드를 기본으로
   * 감추므로 여기서만 `omit: { playerOtp: false }`를 준다. 다른 경로가
   * 이 값을 실으려면 같은 한 줄을 명시해야 하고, 그 순간 리뷰에 걸린다.
   *
   * 끝난 대회의 OTP는 쓸 데가 없다. 목록에 남겨 두면 유출 표면만 넓어지므로
   * 응답에서 뺀다.
   */
  async getMyParticipations(userId: string) {
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
      playerOtp:
        row.tournament.status === TournamentStatus.PENDING ||
        row.tournament.status === TournamentStatus.ONGOING
          ? row.playerOtp
          : null,
    }));
  }
}
