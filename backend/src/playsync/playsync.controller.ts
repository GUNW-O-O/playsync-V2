import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { PlaysyncService } from './playsync.service';

@Controller('playsync')
export class PlaysyncController {

  constructor(private readonly playsyncService: PlaysyncService) { }

  /**
   * WS(`ws.gateway.ts`의 `handleConnection`)가 같은 자원을 여는 또 다른
   * 문이다. `JwtAuthGuard`는 "인증됐는가"만 보고 "이 테이블을 볼 자격이
   * 있는가"는 안 본다 — 그래서 여기서도 `assertTableAccess`(WS와 같은
   * 판정 함수, `PlaysyncService`)를 먼저 부른다(T66).
   *
   * `JwtStrategy`가 역할마다 다른 모양을 준다 — 딜러는 `id`, 그 외는
   * `userId`다(`ws-ticket.controller.ts`의 `issue`와 같은 자리). 딜러
   * JWT에는 `userId`가 없어 `req.user.userId`가 `undefined`이고,
   * `joinTable`은 그 값을 그대로 받아 `seatIndex: -1`을 돌려준다 — 딜러는
   * 애초에 좌석이 없으므로 의도된 동작이다.
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async joinTable(@Param('id') id: string, @Req() req) {
    const isDealer = req.user.role === Role.DEALER;
    const identity = {
      sub: isDealer ? req.user.id : req.user.userId,
      role: req.user.role,
      tableId: req.user.tableId,
    };
    await this.playsyncService.assertTableAccess(identity, id);

    const userId = req.user.userId;
    return await this.playsyncService.joinTable(id, userId);
  }
  
  // 액션 제출은 WS `PLAYER_ACTION` 하나뿐이다. 여기 있던 `POST :id`는 지웠다 —
  // `dto`에 `@Body()`가 없어 Nest가 아무것도 주입하지 않았고(항상 undefined),
  // 그래서 한 번도 동작한 적이 없다. 되살릴 이유도 없다: 인바운드 검증
  // (contract의 `.strict()` zod 스키마)은 게이트웨이에만 있어서, 이 경로는
  // 검증 없이 게임 상태를 쓰는 두 번째 문이 된다.
  @Get('dashboard/:tournamentId')
  async getDashboard(@Param('tournamentId') tournamentId: string) {
    return await this.playsyncService.getDashboardInfo(tournamentId);
  }

}
