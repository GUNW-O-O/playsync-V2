// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

// PrismaClient<ClientOptions>의 ClientOptions가 컴파일 타임 omit을 결정한다
// (Prisma.TournamentParticipationDelegate<ExtArgs, ClientOptions>로 그대로
// 흘러들어가 결과 타입에서 playerOtp를 지운다). `extends PrismaClient`처럼
// 타입 인자를 생략하면 ClientOptions가 기본값(Prisma.PrismaClientOptions,
// omit이 아직 모델별로 좁혀지지 않은 범용 타입)으로 고정돼 omit이 런타임에만
// 적용되고 타입은 그대로 남는다 — 실제로 겪은 문제였다. 여기서 명시한다.
type PrismaClientOptionsWithPlayerOtpOmit = {
  adapter: PrismaPg;
  omit: { tournamentParticipation: { playerOtp: true } };
};

@Injectable()
export class PrismaService
  extends PrismaClient<PrismaClientOptionsWithPlayerOtpOmit>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

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
      // 감춤으로 두면 빠뜨림이 조용한 누출이 아니라 **컴파일 에러**가 된다 —
      // 위 `PrismaClientOptionsWithPlayerOtpOmit` 타입 인자 덕분이다. 그 타입
      // 인자 없이 `extends PrismaClient`만 썼을 때는 이 값이 런타임에만
      // 걸리고 타입은 그대로 남아 빠뜨림이 조용히 `undefined`를 돌려주는
      // 문제가 실제로 있었다.
      //
      // 읽는 곳은 마이페이지 조회 단 하나이고 거기서만 `omit: { playerOtp: false }`를 준다.
      omit: { tournamentParticipation: { playerOtp: true } },
    });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    // 드라이버 어댑터 구성에서는 $disconnect()가 어댑터에 넘긴 pg Pool까지
    // 닫지 않는다(test/helpers/prisma.ts의 closeTestPrisma가 같은 이유로
    // Pool을 따로 추적해 닫는다). 앱 종료 때도 소켓이 남으므로 여기서 닫는다.
    await this.pool.end();
  }
}