import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UserService } from './user.service';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // @Post('points/add')
  // async addPoints(@Body('userId') userId: string) {
  //   return this.userService.addPoint(userId);
  // }

  @Get('/add')
  async getUser(@Req() req) {
    const userId = req.user.userId;
    await this.userService.addPoint(userId);
    // return this.userService.findByUUID(id);
  }

  /**
   * 내 참여 대회 목록. 경로에 userId를 받지 않는다 — 받는 순간 남의 것을
   * 조회할 수 있는지 검사하는 코드가 필요해지고, 그 검사가 빠질 자리가 생긴다.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/participations')
  async getMyParticipations(@Req() req) {
    return await this.userService.getMyParticipations(req.user.userId);
  }
}
