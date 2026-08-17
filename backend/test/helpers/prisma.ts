import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { applyTestEnv } from './test-env';

/**
 * 테스트용 Prisma 클라이언트. 접속 대상은 5433 포트의 테스트 전용 컨테이너다.
 *
 * schema.prisma의 datasource에 url이 없고 드라이버 어댑터를 쓰는 구성이라,
 * PrismaService와 동일하게 PrismaPg 어댑터를 주입해야 한다.
 */
/**
 * $disconnect()는 어댑터에 넘긴 pg Pool까지 닫아주지는 않는다. Pool이 살아 있으면
 * jest가 열린 핸들 때문에 종료되지 않으므로, 클라이언트별 Pool을 기억해 뒀다가
 * closeTestPrisma에서 함께 닫는다.
 */
const pools = new WeakMap<PrismaClient<any>, Pool>();

export function createTestPrisma(): PrismaClient {
  applyTestEnv();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  }

  const pool = new Pool({ connectionString });
  // **omit까지 제품과 같아야 한다**(T51). 예전에는 어댑터만 맞추고 맨
  // `PrismaClient`를 만들었는데, 그러면 통합 테스트가 **제품이 실제로 쓰는
  // 클라이언트 설정을 한 번도 밟지 않는다** — 비밀을 감추는 것이 그 설정에
  // 있으므로, 다르면 "테스트는 초록인데 제품은 샌다"와 그 반대가 둘 다
  // 가능해진다.
  //
  // 감춰진 필드를 읽어야 하는 스펙은 제품과 똑같이 쿼리에서
  // `omit: { ...: false }`로 켠다.
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
    omit: {
      tournamentParticipation: { playerOtp: true },
      tournament: { dealerOtpHash: true },
    },
  });
  pools.set(prisma, pool);
  return prisma;
}

/**
 * 반드시 이걸로 닫을 것. $disconnect()만 부르면 pg Pool이 남는다.
 *
 * 매개변수 타입이 `PrismaClient<any>`인 이유: `PrismaService`는 이제
 * `PrismaClient<PrismaClientOptionsWithPlayerOtpOmit>`로, 결과 타입에서
 * `playerOtp`가 컴파일 타임에 지워진다. 기본 `PrismaClient`(전체 필드 유지)
 * 타입을 그대로 쓰면 그 둘이 구조적으로 호환되지 않아(부분집합 쪽이 필수
 * 필드 누락으로 취급됨) `user.service.int-spec.ts`가 `new PrismaService()`를
 * 여기 넘기지 못한다. 이 함수는 `$disconnect`·`$queryRaw`처럼 omit과 무관한
 * 메서드만 쓰므로 `any`로 넓혀도 안전하다.
 */
export async function closeTestPrisma(prisma: PrismaClient<any>): Promise<void> {
  await prisma.$disconnect();
  await pools.get(prisma)?.end();
}

/**
 * 모든 테이블을 비운다.
 *
 * 테이블 목록을 손으로 관리하면 스키마가 바뀔 때마다 어긋나므로 pg_tables에서 읽는다.
 * _prisma_migrations는 제외한다 — 지우면 마이그레이션 상태가 사라진다.
 */
export async function truncateAll(prisma: PrismaClient<any>): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  // CASCADE로 FK 순서를 신경 쓰지 않고, RESTART IDENTITY로 시퀀스도 되돌린다.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
