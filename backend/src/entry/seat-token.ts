import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { batched } from 'src/common/batched';

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
  const version = await versionLoader(prisma)({ tournamentId: input.tournamentId, userId: input.userId });
  if (version !== input.ver) throw stale();
}

type SeatKey = { tournamentId: string; userId: string };
const loaders = new WeakMap<PrismaService, (key: SeatKey) => Promise<number | undefined>>();

/**
 * 세대 조회를 묶는다(T119, `batched`). 재기동 뒤에는 좌석 전원이 한꺼번에 돌아오고,
 * 기기마다 이 조회를 세 번 한다(티켓 발급 · 접속 · 등록 뒤 재확인) — 하나씩 보내면
 * 풀 10개에 수천 건이 줄을 선다. 대회별로 `IN` 한 번이다. 묶어도 각 확인은 자기보다
 * 뒤에 시작한 조회의 값을 받으므로, 세대를 올린 직후의 확인이 낡은 값을 보지 않는다.
 */
function versionLoader(prisma: PrismaService) {
  let loader = loaders.get(prisma);
  if (!loader) {
    loader = batched<SeatKey, number | undefined>(async (keys) => {
      const byTournament = new Map<string, string[]>();
      for (const k of keys) byTournament.set(k.tournamentId, [...(byTournament.get(k.tournamentId) ?? []), k.userId]);
      const found = new Map<string, number>();
      await Promise.all([...byTournament].map(async ([tournamentId, userIds]) => {
        const rows = await prisma.tournamentParticipation.findMany({
          where: { tournamentId, userId: { in: userIds } },
          select: { userId: true, seatTokenVersion: true },
        });
        for (const row of rows) found.set(`${tournamentId}/${row.userId}`, row.seatTokenVersion);
      }));
      return keys.map((k) => found.get(`${k.tournamentId}/${k.userId}`));
    });
    loaders.set(prisma, loader);
  }
  return loader;
}

function stale() {
  return new ForbiddenException('만료된 좌석입니다. OTP를 다시 입력해 주세요.');
}
