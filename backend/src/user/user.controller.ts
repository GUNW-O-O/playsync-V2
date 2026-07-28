import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/roles.guard';
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
   *
   * `@Roles(Role.USER)`가 필요한 이유: `JwtStrategy.validate`는 딜러 토큰에
   * `userId`를 넣지 않는다(`id`뿐이다). `JwtAuthGuard` 하나만 있으면 유효한
   * 딜러 토큰도 통과해 `req.user.userId`가 `undefined`가 되고, 그 값이
   * `tournamentParticipation.findMany`의 `where`에 그대로 들어가면 필터가
   * 사라져 대회 전체의 평문 OTP가 새어 나간다(`UserService.getMyParticipations`가
   * 이 값을 한 번 더 막지만, 라우트에서도 애초에 딜러 토큰을 들이지 않는다).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @Get('me/participations')
  async getMyParticipations(@Req() req) {
    return await this.userService.getMyParticipations(req.user.userId);
  }
}
