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
const pools = new WeakMap<PrismaClient, Pool>();

export function createTestPrisma(): PrismaClient {
  applyTestEnv();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  pools.set(prisma, pool);
  return prisma;
}

/** 반드시 이걸로 닫을 것. $disconnect()만 부르면 pg Pool이 남는다. */
export async function closeTestPrisma(prisma: PrismaClient): Promise<void> {
  await prisma.$disconnect();
  await pools.get(prisma)?.end();
}

/**
 * 모든 테이블을 비운다.
 *
 * 테이블 목록을 손으로 관리하면 스키마가 바뀔 때마다 어긋나므로 pg_tables에서 읽는다.
 * _prisma_migrations는 제외한다 — 지우면 마이그레이션 상태가 사라진다.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  // CASCADE로 FK 순서를 신경 쓰지 않고, RESTART IDENTITY로 시퀀스도 되돌린다.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
