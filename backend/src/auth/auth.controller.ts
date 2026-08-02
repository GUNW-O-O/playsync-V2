import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto, LoginUserDto } from 'shared/dto/user.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService : AuthService) {};

  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist : true }))
  async login(@Body() dto : LoginUserDto) {
    return this.authService.login(dto);
  }

  /**
   * 참가자 회원가입. **`USER`만 만든다.**
   *
   * 예전에는 `createStoreAdmin`을 가리키고 있었다. 상점 계정을 따로 만드는
   * 경로가 없어 수동 테스트 때 회원가입으로 대신하던 잔재다. 그 상태에서는
   * 누구나 가입만 하면 `/stores/*` 가드(`@Roles(STORE_ADMIN, PLATFORM_ADMIN)`)를
   * 통과해 상점과 대회를 만들 수 있었다.
   *
   * `STORE_ADMIN`은 이제 시드(`prisma/seed.ts`)가 만든다. SaaS라면 플랫폼이
   * 발급하는 자리이고, 그 화면은 범위 밖이다(`docs/backlog.md`의 B5 절).
   */
  @Post('join')
  @UsePipes(new ValidationPipe({ whitelist : true }))
  async join(@Body() dto : CreateUserDto) {
    return await this.authService.createUser(dto);
  }

}
