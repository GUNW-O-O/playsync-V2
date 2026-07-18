import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'super-secret', // 환경변수 관리 필수
    });
  }

  async validate(payload: any) {
    if(payload.role === Role.DEALER) {
      return {
        id : payload.sub,
        tournamentId: payload.tournamentId,
        tableId: payload.tableId,
        role: Role.DEALER,
      }
    }
    return { 
      userId: payload.sub, 
      nickname: payload.nickname, 
      role: payload.role as Role 
    };
  }
}