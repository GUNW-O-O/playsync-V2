import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 좌석 토큰의 세대가 지금 참가 행의 세대와 같은지(T110).
 *
 * `/ws/ticket` 발급과 `handleConnection` 두 자리가 같은 판정을 쓴다 — 두 벌이
 * 되면 한쪽만 고쳐지는 날 폐기된 좌석이 다른 쪽 문으로 들어온다.
 * `ver`가 없는 토큰(배포 전에 나간 것)은 무효다.
 */
export async function assertSeatTokenCurrent(
  prisma: PrismaService,
  input: { userId: string; tournamentId?: string; ver?: number },
): Promise<void> {
  if (!input.tournamentId || typeof input.ver !== 'number') throw stale();
  const row = await prisma.tournamentParticipation.findUnique({
    where: { tournamentId_userId: { tournamentId: input.tournamentId, userId: input.userId } },
    select: { seatTokenVersion: true },
  });
  if (row?.seatTokenVersion !== input.ver) throw stale();
}

function stale() {
  return new ForbiddenException('만료된 좌석입니다. OTP를 다시 입력해 주세요.');
}
