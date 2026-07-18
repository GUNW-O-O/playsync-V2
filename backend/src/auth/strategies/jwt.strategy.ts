import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '@prisma/client';

// 검증 쪽에 기본값이 남아 있으면 서명 쪽만 고쳐도 소용이 없다 — 리포지토리에
// 적힌 키로 서명한 토큰이 그대로 통과한다. 두 곳을 같은 방식으로 막는다.
//
// auth.module.ts처럼 `const` + 모듈 스코프 throw로 쓰지 않은 이유는, 그 좁히기가
// 생성자라는 중첩 스코프까지 따라오지 않아 secretOrKey가 string | undefined로
// 남기 때문이다. 검사와 좁히기를 함수로 묶으면 반환 타입이 string으로 확정된다.
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
  }
  return secret;
}

const JWT_SECRET = requireJwtSecret();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
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