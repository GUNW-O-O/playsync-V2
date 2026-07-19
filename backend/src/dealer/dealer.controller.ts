import { Body, Controller, NotFoundException, Get, Param, Post } from '@nestjs/common';
import { DealerService } from './dealer.service';
import { DealerDto } from 'shared/dto/dealer.dto';
import { SessionService } from 'src/store/session/session.service';

@Controller('dealer')
export class DealerController {
  constructor(private readonly dealerService: DealerService,
    private readonly sessionService: SessionService,
  ) { }

  @Get('/:id')
  async getTournamentWithTables(@Param('id') tournamentId: string) {
    const data = await this.sessionService.getGameSessionWithTables(tournamentId);
    if (!data) throw new NotFoundException('세션을 찾을 수 없습니다.');
    const {dealerOtp, ...rest} = data;
    return rest;
  }


  @Post('auth')
  async loginDealer(@Body() dto: DealerDto) {
    const dealerSession = await this.dealerService.loginDealer(dto);

    if (!dealerSession) throw new NotFoundException('세션을 찾을 수 없습니다.')

    return dealerSession;
  }
}
