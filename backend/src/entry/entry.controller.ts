import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { DeviceGuard } from 'src/device/device.guard';
import { EnterTournamentDto } from 'shared/dto/entry.dto';
import { EntryService } from './entry.service';

/**
 * 대회 입장. 사람의 자격 증명은 **OTP 자체**고, 그 앞에 **기기 문**이 선다
 * (`DeviceGuard`, T112) — 매장이 등록한 태블릿만 OTP를 넣을 수 있다.
 * 딜러 로그인(`POST /dealer/auth`)과 같은 자리다.
 */
@Controller('tournaments')
export class EntryController {
  constructor(private readonly entryService: EntryService) {}

  @UseGuards(DeviceGuard)
  @Post(':id/enter')
  async enter(@Param('id') tournamentId: string, @Body() dto: EnterTournamentDto) {
    return await this.entryService.enterSeat(tournamentId, dto);
  }

  @Get(':id/seats')
  async seats(@Param('id') tournamentId: string) {
    return await this.entryService.getSeatMap(tournamentId);
  }
}
