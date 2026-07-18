import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto, LoginUserDto } from 'shared/dto/user.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService : AuthService) {};

  // @Post('signup')
  // @UsePipes(new ValidationPipe({ whitelist : true }))
  // async signup(@Body() dto : CreateUserDto) {
  //   const user = await this.authService.signup(dto);
  //   return { nickname : user.nickname };
  // }

  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist : true }))
  async login(@Body() dto : LoginUserDto) {
    return this.authService.login(dto);
  }

  @Post('join')
  @UsePipes(new ValidationPipe({ whitelist : true }))
  async storeOwnerSignin(@Body() dto : CreateUserDto) {
    return await this.authService.createStoreAdmin(dto);
  }

}
