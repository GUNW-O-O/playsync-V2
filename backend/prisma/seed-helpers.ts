import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { createEmptyTableState } from '../src/game-engine/types';

/**
 * 시드 둘이 함께 쓰는 것들.
 *
 * `seed.ts`(데모)와 `seed-load.ts`(부하)는 목적이 달라 본문을 나누지만, 무대를
 * 세우는 손짓 자체는 같다 — 전부 지우고, 테이블마다 Redis 쪽 자리를 만든다.
 *
 * **`RedisService`를 부르지 않는다.** Nest 프로바이더라 모듈 그래프를 통째로
 * 끌고 온다. 시드 하나 때문에 앱을 부팅시키지 않는다. 대신 키와 형식이
 * 제품 코드와 어긋나면 조용히 깨지므로, 어느 함수를 따라 만든 것인지 각
 * 주석에 적어 둔다.
 */

/** 한 테이블의 좌석 수. `createEmptyTableState`와 같은 값이어야 한다. */
const SEAT_COUNT = 9;

/**
 * 전부 지운다.
 *
 * **시드는 지우고 다시 만든다.** 데모는 매번 같은 화면에서 시작해야 하고,
 * 부하는 직전 실행이 만든 수천 명이 남아 있으면 규모 축이 흐려진다.
 */
export async function resetAll(prisma: PrismaClient, redis: Redis) {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  if (rows.length > 0) {
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await redis.flushdb();
}

/**
 * `RedisService.setSeatBitmap`과 같은 키·같은 형식이다.
 *
 * 비트맵을 세워 두지 않으면 사람이 앉아도 좌석 목록이 계속 비어 있다 —
 * `UPDATE_SEAT_BIT`은 필드가 없으면 아무것도 하지 않는다(T25가 지워진 테이블이
 * 착석으로 되살아나는 것을 막으며 정한 규칙).
 */
export async function setSeatBitmap(redis: Redis, tournamentId: string, tableId: string) {
  const key = `tournament:${tournamentId}:seat`;
  await redis.hset(key, `table:${tableId}`, '0'.repeat(SEAT_COUNT));
  await redis.expire(key, 86400);
}

/**
 * 빈 테이블의 스냅샷. `createEmptyTableState`(`src/game-engine/types.ts`)와
 * 같은 모양이고 `RedisService.saveSnapShot`과 같은 키·TTL이다.
 *
 * **T38이 세운 불변식을 시드도 지켜야 한다** — "테이블이 있으면 스냅샷이
 * 있다". 제품 경로에서는 `createTable`이 세우지만, 시드는 무대를 빨리 세우려고
 * `prisma.table.create`로 직접 만들기 때문에 그 경로를 타지 않는다.
 *
 * 없으면 아무도 앉기 전에 딜러 화면이 부르는 `GET /playsync/:tableId`가 맨
 * `Error`로 죽어 500이 난다. T38이 제품 경로에서 닫은 것과 같은 결함이
 * 시드 뒤에 남아 있었다.
 */
export async function setEmptySnapshot(redis: Redis, tournamentId: string, tableId: string) {
  const key = `table:state:${tableId}`;
  await redis.set(key, JSON.stringify(createEmptyTableState(tournamentId)));
  await redis.expire(key, 86400);
}
