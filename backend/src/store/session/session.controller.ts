// src/store/session/session.controller.ts
import { Controller, Get, Post, Patch, Body, Param, Req, UseGuards } from '@nestjs/common';
import { SessionService } from './session.service';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { CreateTournamentDto, UpdateTournamentDto } from 'shared/dto/tournament.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN, Role.PLATFORM_ADMIN)
@Controller('store/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  async create(@Body('dto') dto: CreateTournamentDto, @Body('blindStructure') blindStructure?: any) {
    return await this.sessionService.createSession(dto, blindStructure);
  }

  @Get(':storeId')
  async findAll(@Param('storeId') storeId: string) {
    return await this.sessionService.getStoreAllSessions(storeId);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTournamentDto) {
    return await this.sessionService.updateSession(id, dto);
  }

  @Patch(':id/start')
  async start(@Param('id') id: string) {
    return await this.sessionService.startSession(id);
  }

  @Patch(':id/complete')
  async complete(@Param('id') id: string) {
    return await this.sessionService.completeSession(id);
  }

  // 재발급/내보내기는 다른 상점의 대회를 건드릴 수 없어야 한다 — 재발급은
  // 평문 OTP를 응답에 실어 돌려주므로 역할만 확인하고 지나가면 그대로
  // 남의 대회 딜러 접근권을 만들어내는 경로가 된다. 소유권 확인은
  // 컨트롤러가 아니라 서비스 메서드 안에서 한다(session.service.ts의
  // assertTournamentOwnership 주석 참고) — 여기서는 호출자 id만 넘긴다.
  //
  // 클래스 수준 권한은 STORE_ADMIN·PLATFORM_ADMIN 둘 다 허용하지만, 이
  // 둘은 평문 OTP를 돌려주는 돈 경로라 PLATFORM_ADMIN까지 우회 길을
  // 늘리지 않는다 — STORE_ADMIN 전용으로 메서드 수준에서 좁힌다.
  @Roles(Role.STORE_ADMIN)
  @Post(':id/dealer-otp/reissue')
  async reissueDealerOtp(@Req() req, @Param('id') tournamentId: string) {
    return await this.sessionService.reissueDealerOtp(tournamentId, req.user.userId);
  }

  @Roles(Role.STORE_ADMIN)
  @Post(':id/dealer-session/revoke')
  async revokeDealerSession(@Req() req, @Param('id') tournamentId: string) {
    await this.sessionService.revokeDealerSession(tournamentId, req.user.userId);
    return { ok: true };
  }
}
