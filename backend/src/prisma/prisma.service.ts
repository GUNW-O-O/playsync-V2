// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('❌ DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    }
    // 2. pg Pool을 명시적으로 생성하여 어댑터에 전달 (권장 방식)
    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    // const adapter = new PrismaPg({ url: process.env.DATABASE_URL });
    super({
      adapter,
      // 참가 OTP는 평문이고 참가자 전원의 값이 한 테이블에 있다. 상점 콘솔의
      // 참가자 목록 한 번이면 대회 전체가 샌다.
      //
      // 호출부마다 `omit`을 쓰는 규율로는 막지 못한다 — T23이 딜러 OTP 해시에
      // 대해 정확히 그 방식이었고 두 곳을 빠뜨려 실제로 누출됐다. 기본을
      // 감춤으로 두면 빠뜨림이 조용한 누출이 아니라 **컴파일 에러**가 된다.
      //
      // 읽는 곳은 마이페이지 조회 단 하나이고 거기서만 `omit: { playerOtp: false }`를 준다.
      omit: { tournamentParticipation: { playerOtp: true } },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}