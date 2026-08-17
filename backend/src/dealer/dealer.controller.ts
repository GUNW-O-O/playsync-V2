import { Body, Controller, ForbiddenException, NotFoundException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { authThrottle } from 'src/auth/throttle';
import { DealerService } from './dealer.service';
import { DealerDto } from 'shared/dto/dealer.dto';
import { SessionService } from 'src/store/session/session.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@Controller('dealer')
export class DealerController {
  constructor(private readonly dealerService: DealerService,
    private readonly sessionService: SessionService,
  ) { }

  @Get('/:id')
  async getTournamentWithTables(@Param('id') tournamentId: string) {
    const data = await this.sessionService.getGameSessionWithTables(tournamentId);
    if (!data) throw new NotFoundException('세션을 찾을 수 없습니다.');
    return data;
  }


  /**
   * 대회 단위 잠금(`OtpAttempts`)이 추측을 막고, 이 상한이 **폭주**를 막는다.
   * 잠금만 있으면 틀린 OTP 한도만큼으로 그 대회의 로그인 창구를 공짜로 닫을 수
   * 있다 — 방어 장치를 무기로 쓰는 쪽에 값을 매기는 것이 여기다(T53).
   */
  @Throttle(authThrottle())
  @Post('auth')
  async loginDealer(@Body() dto: DealerDto) {
    const dealerSession = await this.dealerService.loginDealer(dto);

    if (!dealerSession) throw new NotFoundException('세션을 찾을 수 없습니다.')

    return dealerSession;
  }

  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  async refresh(@Req() req: any) {
    if (req.user.role !== Role.DEALER) {
      throw new ForbiddenException('딜러 토큰이 아닙니다.');
    }
    // JwtStrategy가 딜러 페이로드의 `sub`를 `id`로 바꿔 내보낸다.
    return this.dealerService.refreshToken({
      sub: req.user.id,
      tournamentId: req.user.tournamentId,
      tableId: req.user.tableId,
      tokenVersion: req.user.tokenVersion,
    });
  }
}
