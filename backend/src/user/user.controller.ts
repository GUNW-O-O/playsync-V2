import { Controller, Get, Req } from '@nestjs/common';
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
  
}
