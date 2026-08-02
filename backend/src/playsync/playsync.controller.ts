import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { PlaysyncService } from './playsync.service';

@Controller('playsync')
export class PlaysyncController {
  
  constructor(private readonly playsyncService: PlaysyncService) { }
  
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async joinTable(@Param('id') id: string, @Req() req) {
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
