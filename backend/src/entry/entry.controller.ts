import { Body, Controller, Param, Post } from '@nestjs/common';
import { EnterTournamentDto } from 'shared/dto/entry.dto';
import { EntryService } from './entry.service';

/**
 * 대회 입장. 가드가 없다 — **OTP 자체가 자격 증명**이다. 딜러 로그인
 * (`POST /dealer/auth`)과 같은 자리다.
 */
@Controller('tournaments')
export class EntryController {
  constructor(private readonly entryService: EntryService) {}

  @Post(':id/enter')
  async enter(@Param('id') tournamentId: string, @Body() dto: EnterTournamentDto) {
    return await this.entryService.enterSeat(tournamentId, dto);
  }
}
