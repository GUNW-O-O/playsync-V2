import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { CreateUserDto, LoginUserDto } from 'shared/dto/user.dto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
import { UserService } from 'src/user/user.service';
import { JwtService } from '@nestjs/jwt';
import { tokenTtl } from './token-ttl';


/**
 * 신규 가입이 싣고 나오는 초기 포인트. **기본은 0이다.**
 *
 * 실 PG 연동 계획이 없다 — 지금은 회원가입이 포인트를 주지 않고 충전 경로도
 * 없어서, 포인트 차감이 결제를 대신하고 있다(`seed-load.ts`의 `BOT_POINTS`
 * 주석 참고). 일반 가입에 기본으로 포인트를 얹으면 결제 없이 참가할 길이
 * 그대로 열린다.
 *
 * 부하 램프의 `NEW_USER_RATIO`(`load/lib/table.js`) 분기는 실행 중에
 * signup → login → joinTournament를 탄다. 신규 가입 봇이 포인트 0으로
 * 나오면 `PaymentService.joinSession`의 `user.points < session.entryFee`
 * 게이트에 막혀 409로 VU가 죽는다 — 부하 무대에서만 이 환경변수를 켠다.
 * 값은 `seed-load.ts`의 `BOT_POINTS`와 **같은 환경변수**를 읽는다(근거는
 * `load/README.md`) — 두 벌이 되면 어긋난다.
 *
 * 호출 시점에 읽는 것은 `minPlayersToStart`(`session.service.ts`)와 같은
 * 이유다 — 모듈 로드 시점에 고정하면 테스트가 값을 바꿀 수 없다.
 */
function signupInitialPoints(): number {
  return Number(process.env.SIGNUP_INITIAL_POINTS ?? 0);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private userService: UserService,
    private jwtService: JwtService,
  ) { };

  async createUser(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { nickname: dto.nickname } });
    if (existing) throw new BadRequestException('이미 존재하는 ID입니다.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { nickname: dto.nickname, password: hashedPassword, points: signupInitialPoints() },
    });
    return user ? (`회원가입 성공! ID는 ${user.nickname} 입니다.`) : ('회원가입 실패');
  }

  /**
   * `STORE_ADMIN`을 만든다. **HTTP 라우트가 없다.**
   *
   * SaaS라 상점 계정은 플랫폼이 발급하고 가입 폼으로 만들어지지 않는다.
   * 예전에는 `POST /auth/join`이 이 메서드를 가리켰는데, 상점 계정을 따로
   * 만들 방법이 없어 수동 테스트가 회원가입으로 대신하던 잔재였다.
   *
   * 지금 호출자는 시드(`prisma/seed.ts`)와 시나리오 테스트뿐이다. 라우트를
   * 다시 붙이면 그 순간 누구나 상점 관리자가 된다.
   */
  async createStoreAdmin(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { nickname: dto.nickname } });
    if (existing) throw new BadRequestException('이미 존재하는 ID입니다.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const owner = await this.prisma.user.create({
      data: { nickname: dto.nickname, password: hashedPassword, role: Role.STORE_ADMIN },
    });
    return owner ? (`회원가입 성공! ID는 ${owner.nickname} 입니다.`) : ('회원가입 실패');
  }

  async login(dto: LoginUserDto) {
    const user = await this.userService.findByNickname(dto.nickname);
    if (!user) throw new UnauthorizedException('비밀번호나 닉네임이 틀렸습니다.');

    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch) throw new UnauthorizedException('비밀번호나 닉네임이 틀렸습니다.')

    return {
      // 수명이 역할마다 다르다. 상점 콘솔은 행사 내내 켜져 있고, 손님 폰은
      // 재로그인이 자연스럽다. 근거는 `token-ttl.ts`에.
      accessToken: this.jwtService.sign(
        {
          sub: user.id,
          nickname: user.nickname,
          role: user.role,
        },
        { expiresIn: tokenTtl(user.role) },
      ),
    };
  }

}
