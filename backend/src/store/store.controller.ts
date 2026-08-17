import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { StoreService } from './store.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

@Controller('store')
@UseGuards(JwtAuthGuard, RolesGuard )
@Roles(Role.STORE_ADMIN, Role.PLATFORM_ADMIN)
export class StoreController {
  constructor(private storeService: StoreService) { };

  @Get()
  async getUserStores(@Req() req) {
    return this.storeService.getUserStores(req.user.userId);
  }

  @Get('/:id')
  async getStoreDetail(@Req() req, @Param('id') id: string) {
    return this.storeService.getStoreDetail(id, req.user.userId);
  }

  // 상점 생성·수정·삭제 라우트는 없다.
  //
  // 상점은 시드(`prisma/seed.ts`)가 만든다 — 부하 무대도 데모도 거기서
  // 출발한다. 프론트에 호출자가 하나도 없었고, SaaS라면 플랫폼의 온보딩
  // 화면이 설 자리인데 그 화면은 범위 밖이다. T32가 `createStoreAdmin`에
  // 한 것과 같은 처리다 — 서비스 메서드(`createStore`/`updateStore`/
  // `removeStore`)는 남기고 라우트만 끊는다.
  //
  // 끊는 김에 닫힌 구멍이 둘 있다. `PUT :id`는 소유자를 `dto.ownerId`
  // (요청 본문)에서, `DELETE :ownerId/:id`는 URL 파라미터에서 뽑아 그 값끼리
  // 비교했다 — 남의 `ownerId`를 실어 보내면 검사가 그대로 통과했다.
  // 권한의 진실이 토큰이 아니라 클라이언트 입력이었던 셈이다. 다시 여는
  // 날에는 소유자를 `req.user.userId`에서 뽑아야 한다.

}