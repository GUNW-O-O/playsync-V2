import { Body, Controller, ForbiddenException, NotFoundException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
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
