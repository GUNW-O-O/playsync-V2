import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ChargePointDto } from 'shared/dto/payment.dto';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { PaymentService } from './payment.service';

/**
 * 목업 결제의 충전 라우트(T72).
 *
 * **별도 컨트롤러인 이유는 게이팅이다.** `PaymentController`에 메서드로 붙이면
 * 그 컨트롤러 전체가 목업 설정에 묶이거나, 아니면 요청 시점 가드를 하나 더
 * 두게 된다. 컨트롤러를 갈라 두면 `PaymentModule`이 **등록 자체를** 조건부로
 * 할 수 있고, 꺼져 있을 때 이 라우트는 존재하지 않는다.
 *
 * 접두사도 갈랐다. 포인트 충전은 대회에 매인 일이 아니라
 * `@Controller('tournaments')` 아래에 둘 자리가 없다.
 */
@Controller('payments')
export class MockPaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  /**
   * 충전은 플레이어(USER)만 한다.
   *
   * 참가(`PaymentController.joinSession`)와 같은 이유다 — 상점 직원이
   * 플레이하고 싶으면 별도 플레이어 계정을 쓴다는 결정이 서 있는데, 충전만
   * 열어 두면 STORE_ADMIN이 자기 포인트를 늘릴 수 있다.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @Post('charge')
  async charge(@Body() dto: ChargePointDto, @Req() req: any) {
    return await this.paymentService.chargePoint(req.user.userId, dto.amount);
  }

}
