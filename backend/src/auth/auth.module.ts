import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserModule } from 'src/user/user.module';
import { RolesGuard } from './guard/roles.guard';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy';

// 기본값을 두면 키가 빠진 배포가 조용히 성공한다 — 그리고 그 키는 리포지토리에
// 적혀 있으므로 아무나 관리자 토큰을 서명할 수 있다. 인증이 있는 척만 하는 상태다.
// 부팅을 막는 쪽이 낫다. main.ts 첫 줄의 `import 'dotenv/config'`가 이 모듈보다
// 먼저 평가되므로 모듈 스코프에서 읽어도 .env는 이미 적용돼 있다.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
}

@Module({
  imports : [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      global: true,
      secret: JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    UserModule,
  ],
  controllers : [AuthController],
  providers : [AuthService, RolesGuard, JwtStrategy],
  exports : [RolesGuard, JwtStrategy, PassportModule, JwtModule]
})
export class AuthModule {}
