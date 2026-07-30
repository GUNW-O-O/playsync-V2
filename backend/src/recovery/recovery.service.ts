import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TournamentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildTournamentMeta } from 'src/store/session/tournament-meta';

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    await this.recoverAll();
  }

  /**
   * 하트비트가 마지막으로 찍힌 뒤 흐른 시간. 행이 없으면 `null`(최초 부팅).
   *
   * 임계값을 두지 않는다. 정상 재시작 5초도 5초 밀리는데 그게 맞다 — 그 5초
   * 동안 대회는 진짜로 돌지 않았다. "얼마 이상이면 장애"를 정하면 그 미만의
   * 정지가 조용히 진행 시간으로 들어간다.
   */
  async downtimeMs(): Promise<number | null> {
    const beat = await this.prisma.serverHeartbeat.findUnique({
      where: { id: 'singleton' },
    });
    if (!beat) return null;
    return Math.max(0, Date.now() - beat.beatAt.getTime());
  }

  /**
   * 부팅 복구. **서버는 무슨 장애였는지 추측하지 않는다** — 지금 무엇이
   * 없는지만 본다.
   *
   * 실패는 대회 단위로 격리한다. 대회 하나 때문에 프로세스가 안 뜨면 다른
   * 대회까지 서비스가 없어진다. 조용해지는 것이 아니다 — 실패한 대회는
   * Redis 키가 계속 없으므로 게임 경로가 전부 던지고 딜러가 첫 액션에서 안다.
   * 그 안전성은 `entry`의 빈 스냅샷 fallback 금지에 의존한다(Task 3).
   */
  async recoverAll(): Promise<void> {
    const downtime = await this.downtimeMs();
    if (downtime === null) {
      this.logger.log('하트비트가 없다 — 최초 부팅으로 보고 정지 시간 보정을 건너뛴다');
    }

    const tournaments = await this.prisma.tournament.findMany({
      where: { status: TournamentStatus.ONGOING },
      select: { id: true },
    });

    for (const t of tournaments) {
      try {
        await this.recoverTournament(t.id, downtime ?? 0);
      } catch (e) {
        this.logger.error(`대회 복구 실패 (tournament=${t.id})`, e as Error);
      }
    }
  }

  private async recoverTournament(tournamentId: string, downtime: number) {
    // 1. 누적 정지 시간을 더한다. increment이지 대입이 아니다 — 대회 하나가
    //    두 번 장애를 겪으면 Redis 기준점은 이미 첫 번째만큼 밀려 있다.
    const t = downtime > 0
      ? await this.prisma.tournament.update({
          where: { id: tournamentId },
          data: { pausedMs: { increment: downtime } },
          include: { blindStructure: true },
        })
      : await this.prisma.tournament.findUniqueOrThrow({
          where: { id: tournamentId },
          include: { blindStructure: true },
        });

    // 2. **대회 단위**로 블라인드 기준점을 다룬다. blindField는 대회 하나에
    //    하나(`tournament:{id}:info`)이므로, 테이블 루프 안에서 밀면 테이블
    //    수만큼 밀린다.
    const blind = await this.redis.getTournamentBlind(tournamentId);
    if (blind) {
      if (downtime > 0) {
        await this.redis.setTournamentBlind(tournamentId, {
          ...blind,
          startedAt: blind.startedAt + downtime,
        });
      }
    } else {
      // 메타를 통째로 잃었다. DB로 다시 세운다. 기준점은 대회가 실제로
      // 시작한 시각에 누적 정지를 더한 값이다.
      if (!t.startedAt) throw new Error('ONGOING인데 startedAt이 없다');
      const { dashboard, blindField } = buildTournamentMeta(
        t,
        t.startedAt.getTime() + t.pausedMs,
      );
      await this.redis.setTournamentMeta(tournamentId, dashboard, blindField);
    }

    // 3. 테이블 단위 재구성은 Task 3이 채운다.
  }
}
