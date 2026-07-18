import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserModule } from 'src/user/user.module';
import { RolesGuard } from './guard/roles.guard';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports : [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'super-secret',
      signOptions: { expiresIn: '1h' },
    }),
    UserModule,
  ],
  controllers : [AuthController],
  providers : [AuthService, RolesGuard, JwtStrategy],
  exports : [RolesGuard, JwtStrategy, PassportModule, JwtModule]
})
export class AuthModule {}
