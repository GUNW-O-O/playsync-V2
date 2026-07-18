import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PayMentDto } from 'shared/dto/payment.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@Controller('tournaments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Get('/stores')
  async searchStore(@Query('id') id: string) {
    const res = await this.paymentService.searchStore(id);
    if (!res) throw new Error('가맹점 없음');
    return res;
  }

  @Get('/stores/:storeId')
  async findAvailableSessions(@Param('storeId') storeId: string) {
    const data = await this.paymentService.getStoreAvailableSessions(storeId);
    if (!data) throw new Error('세션 없음');
    return data.map(({ dealerOtp, ...rest }) => rest);
  }

  @Get(':id')
  async getTournamentInfo(@Param('id') id: string) {
    return await this.paymentService.getTournamentInfo(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('payment')
  async joinSession(@Body() dto: PayMentDto, @Req() req: any) {
    const userId = req.user.userId;
    return await this.paymentService.joinSessionWithSeat(dto, userId);
  }

}
