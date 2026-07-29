import { Body, Controller, NotFoundException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PaymentService } from './payment.service';
import { PayMentDto } from 'shared/dto/payment.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';

@Controller('tournaments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Get('/stores')
  async searchStore(@Query('id') id: string) {
    const res = await this.paymentService.searchStore(id);
    if (!res) throw new NotFoundException('가맹점을 찾을 수 없습니다.');
    return res;
  }

  @Get('/stores/:storeId')
  async findAvailableSessions(@Param('storeId') storeId: string) {
    const data = await this.paymentService.getStoreAvailableSessions(storeId);
    if (!data) throw new NotFoundException('세션을 찾을 수 없습니다.');
    return data;
  }

  @Get(':id')
  async getTournamentInfo(@Param('id') id: string) {
    return await this.paymentService.getTournamentInfo(id);
  }

  // 대회 참가는 플레이어(USER)만 한다 — 상점 직원이 플레이하고 싶으면 별도
  // 플레이어 계정을 쓴다(운영 결정). `JwtAuthGuard`만으로는 STORE_ADMIN 같은
  // 다른 역할의 유효한 토큰도 통과한다. 여기서 막지 않으면 STORE_ADMIN이
  // 참가비를 내고 `playerOtp`를 발급받은 뒤, `GET /user/me/participations`가
  // `@Roles(Role.USER)`로 막혀 있어 그 OTP를 다시 읽을 방법이 없는 상태가
  // 된다 — 재발급 엔드포인트도 없다.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @Post('payment')
  async joinSession(@Body() dto: PayMentDto, @Req() req: any) {
    const userId = req.user.userId;
    return await this.paymentService.joinSession(dto, userId);
  }

}
