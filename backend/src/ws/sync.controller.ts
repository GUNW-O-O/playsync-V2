import { ConflictException, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { SessionService } from 'src/store/session/session.service';
import { WsGateway } from './ws.gateway';

/**
 * 상점 콘솔의 재기동 복구(T117). 경로는 `store/sessions`지만 이 모듈에 있다 —
 * 판정이 게이트웨이의 소켓 맵에 있고, `SessionModule`에 두면 `DealerModule`을
 * 거쳐 모듈 순환이 된다. 소유권은 다른 운영 조작과 같은
 * `SessionService.assertTournamentOwnership`이다.
 *
 * STORE_ADMIN만 — 대회를 여는 돈 경로와 같은 문이다(`SessionController`의 abort).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN)
@Controller('store/sessions')
export class SyncController {
  constructor(
    private readonly gateway: WsGateway,
    private readonly sessions: SessionService,
  ) {}

  @Get(':id/sync')
  async status(@Req() req, @Param('id') id: string) {
    await this.sessions.assertTournamentOwnership(id, req.user.userId);
    return this.gateway.syncStatus(id);
  }

  @Post(':id/sync/force')
  async force(@Req() req, @Param('id') id: string) {
    await this.sessions.assertTournamentOwnership(id, req.user.userId);
    if (!(await this.gateway.forceSync(id))) {
      throw new ConflictException('복구 중인 대회가 아닙니다.');
    }
    return { ok: true };
  }
}
