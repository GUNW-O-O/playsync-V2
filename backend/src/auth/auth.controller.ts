import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CreateUserDto, LoginUserDto } from 'shared/dto/user.dto';
import { authThrottle } from './throttle';

@Controller('auth')
export class AuthController {
  constructor(private authService : AuthService) {};

  /**
   * 전역 상한보다 좁게 잡는다. 인증 없는 라우트인데 bcrypt를 돌리는 자리라,
   * 여기가 스레드풀을 직접 태울 수 있는 문이다(T41 실측 p50 58ms).
   * 근거와 값은 `throttle.ts`에.
   */
  @Throttle(authThrottle())
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
  @Throttle(authThrottle())
  @Post('join')
  @UsePipes(new ValidationPipe({ whitelist : true }))
  async join(@Body() dto : CreateUserDto) {
    return await this.authService.createUser(dto);
  }

}
