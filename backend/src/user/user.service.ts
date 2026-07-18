import { Injectable, NotFoundException } from '@nestjs/common';
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
}
