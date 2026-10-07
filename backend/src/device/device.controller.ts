import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
import { DeviceService } from './device.service';

/**
 * 점주가 태블릿을 등록하고 해제한다. `PLATFORM_ADMIN`은 넣지 않는다 —
 * 상점 소유자가 아니라 소유권 판정을 통과할 수 없다.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STORE_ADMIN)
@Controller('store/:storeId/devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Post()
  async register(@Req() req, @Param('storeId') storeId: string) {
    return await this.deviceService.register(storeId, req.user.userId);
  }

  @Post('revoke')
  async revokeAll(@Req() req, @Param('storeId') storeId: string) {
    return await this.deviceService.revokeAll(storeId, req.user.userId);
  }
}
