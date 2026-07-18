import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { CreateUserDto, LoginUserDto } from 'shared/dto/user.dto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
import { UserService } from 'src/user/user.service';
import { JwtService } from '@nestjs/jwt';


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
      data: { nickname: dto.nickname, password: hashedPassword },
    });
    return user ? (`회원가입 성공! ID는 ${user.nickname} 입니다.`) : ('회원가입 실패');
  }

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
      accessToken: this.jwtService.sign({
        sub: user.id,
        nickname: user.nickname,
        role: user.role,
      }),
    };
  }

}
