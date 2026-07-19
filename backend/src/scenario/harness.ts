import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DealerService } from 'src/dealer/dealer.service';
import { GamePhase, TableState } from 'src/game-engine/types';
import { PaymentService } from 'src/payment/payment.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { UserService } from 'src/user/user.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 시나리오 테스트의 공용 배선.
 *
 * 시나리오마다 대회를 새로 세워야 하는데, 그 준비가 시나리오 본문보다 길면
 * 무엇을 검증하는지 읽히지 않는다. 배선과 불변식을 여기로 뺀다.
 *
 * 서비스는 전부 **진짜**다. 스텁은 하나도 없다 — 이 계층의 목적이 "부품이
 * 아니라 조립을 본다"이기 때문이다.
 */

export const SCENARIO = {
  store: 'store-1',
  owner: 'owner-1',
  blind: 'blind-1',
  startStack: 10000,
  entryFee: 1000,
  initialPoints: 50000,
};

export interface Harness {
  redis: Redis;
  prisma: PrismaClient;
  redisService: RedisService;
  playsync: PlaysyncService;
  dealer: DealerService;
  session: SessionService;
  payment: PaymentService;
  emitter: EventEmitter2;
  queue: Queue;

  tournamentId: string;
  tableId: string;

  snapshot(): Promise<TableState>;
  saveSnapshot(state: TableState): Promise<void>;
  seatOf(state: TableState, id: string): number;
  /** 지금 차례인 플레이어의 id. 없으면 null. */
  turnId(state: TableState): string | null;
  close(): Promise<void>;
}

let handles: {
  redis: Redis;
  queueConnection: Redis;
  queue: Queue;
  prisma: PrismaClient;
} | null = null;

/**
 * 대회 하나를 세우고 지정한 인원을 착석시킨다.
 *
 * @param players 착석할 유저 id. 순서가 곧 좌석 번호다.
 * @param opts.blindDuration 분. 시나리오 도중 레벨이 오르지 않도록 크게 잡는다.
 */
export async function setupTournament(
  players: string[],
  opts: {
    registrationOpen?: boolean;
    rebuyUntil?: number;
    /** 레벨 상승을 보는 시나리오만 여러 레벨을 넣는다. */
    blindStructure?: { lv: number; sb: number; ante: boolean; duration: number }[];
    prizePayouts?: { place: number; percent: number }[];
  } = {},
): Promise<Harness> {
  const redis = createTestRedis();
  const queueConnection = createTestRedis({ maxRetriesPerRequest: null });
  const queue = new Queue('player-timeout', { connection: queueConnection });
  const prisma = createTestPrisma();
  handles = { redis, queueConnection, queue, prisma };

  await truncateAll(prisma);
  await flushTestRedis(redis);

  const prismaService = prisma as unknown as PrismaService;
  const emitter = new EventEmitter2();
  const redisService = new RedisService(redis);
  const playsync = new PlaysyncService(queue, redisService, prismaService, emitter);
  const session = new SessionService(prismaService, redisService);
  const user = new UserService(prismaService);
  const payment = new PaymentService(user, session, prismaService, redisService, emitter);
  const dealer = new DealerService(
    queue, prismaService, redisService, playsync, {} as JwtService,
  );

  // 시작 최소 인원은 운영 기본값이 6이다. 시나리오는 인원을 자유롭게 잡아야
  // 하므로 여기서 낮춘다 — 검증 대상이 인원 규칙이 아니라 게임 진행이다.
  process.env.MIN_PLAYERS_TO_START = '2';

  await prisma.user.create({
    data: {
      id: SCENARIO.owner, nickname: 'owner', password: 'x',
      points: 0, role: 'STORE_ADMIN',
    },
  });
  await prisma.store.create({
    data: { id: SCENARIO.store, name: '테스트 상점', ownerId: SCENARIO.owner },
  });
  await prisma.blindStructure.create({
    data: {
      id: SCENARIO.blind, name: '기본', storeId: SCENARIO.store,
      structure: opts.blindStructure
        ?? [{ lv: 1, sb: 100, ante: false, duration: 60 }],
    },
  });

  await session.createSession({
    name: '시나리오 대회',
    type: 'TOURNAMENT',
    storeId: SCENARIO.store,
    startStack: SCENARIO.startStack,
    entryFee: SCENARIO.entryFee,
    rebuyUntil: opts.rebuyUntil ?? 5,
    // 상금 분배율은 대회 생성 시 상점이 정한다. itmCount는 여기서 파생된다.
    prizePayouts: opts.prizePayouts ?? [{ place: 1, percent: 100 }],
    // 착석 자체가 등록이라 열려 있어야 한다. 리바인 가능 여부도 이 값이 정하므로
    // 리바인을 보지 않는 시나리오는 착석을 마친 뒤 닫는다(`closeRegistration`).
    isRegistrationOpen: opts.registrationOpen ?? true,
    blindId: SCENARIO.blind,
  } as never);

  // `createSession`은 아무것도 반환하지 않는다. 의도된 설계다 — 대회 정보와
  // 딜러 OTP는 상점 관리 페이지가 따로 조회해서 보여준다.
  const created = await prisma.tournament.findFirstOrThrow({
    where: { storeId: SCENARIO.store },
  });
  const table = await prisma.table.findFirstOrThrow({
    where: { tournamentId: created.id },
  });

  await prisma.user.createMany({
    data: players.map(id => ({
      id, nickname: id, password: 'x', points: SCENARIO.initialPoints,
    })),
  });

  for (const [seat, id] of players.entries()) {
    await payment.joinSessionWithSeat(
      { tournamentId: created.id, tableId: table.id, seatIndex: seat }, id,
    );
  }

  await session.startSession(created.id);

  const stateKey = `table:state:${table.id}`;

  return {
    redis, prisma, redisService, playsync, dealer, session, payment, emitter, queue,
    tournamentId: created.id,
    tableId: table.id,

    async snapshot() {
      const raw = await redis.get(stateKey);
      if (!raw) throw new Error('스냅샷이 없다');
      return JSON.parse(raw) as TableState;
    },
    async saveSnapshot(state: TableState) {
      await redis.set(stateKey, JSON.stringify(state));
    },
    seatOf(state, id) {
      return state.players.findIndex(p => p?.id === id);
    },
    turnId(state) {
      if (state.currentTurnSeatIndex === -1) return null;
      return state.players[state.currentTurnSeatIndex]?.id ?? null;
    },
    async close() {
      delete process.env.MIN_PLAYERS_TO_START;
      await queue.close();
      await queueConnection.quit();
      await redis.quit();
      await closeTestPrisma(prisma);
      handles = null;
    },
  };
}

/**
 * 이 도메인에서 항상 참이어야 하는 것들.
 *
 * **단계마다 부르는 것이 요점이다.** 마지막에 한 번만 보면 "어딘가에서 칩이
 * 사라졌다"까지만 알 수 있다 — T15의 사이드팟 증발이 정확히 그 모양이었다.
 * 틀어진 첫 순간을 잡아야 원인을 좁힐 수 있다.
 *
 * 실패 메시지에 단계 이름이 남도록 값을 문자열로 감싼다. `expect(5000)` 대신
 * `expect('플랍 p2 FOLD: 칩 5000')`이 떠야 어디서 틀어졌는지 바로 읽힌다.
 *
 * @param expectedChips 테이블 위에 있어야 할 칩 총량. 리바인처럼 칩이 정당하게
 *   늘어나는 시나리오는 호출자가 갱신해서 넘긴다.
 */
export async function checkInvariants(
  h: Harness,
  label: string,
  expectedChips: number,
): Promise<TableState> {
  const state = await h.snapshot();

  // 1. 칩은 만들어지지도 사라지지도 않는다. 카드가 실물이라 부기가 틀리면
  //    되돌릴 근거가 테이블 위에 남지 않는다.
  const onTable =
    state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;
  expect(`${label}: 칩 ${onTable}`).toBe(`${label}: 칩 ${expectedChips}`);

  // 2. 사이드팟 총액은 팟과 일치한다.
  if (state.sidePots.length > 0) {
    const sum = state.sidePots.reduce((acc, p) => acc + p.amount, 0);
    expect(`${label}: 사이드팟합 ${sum}`).toBe(`${label}: 사이드팟합 ${state.pot}`);
  }

  // 3. 폴드한 사람은 어느 사이드팟의 자격자도 아니다 (T15).
  //
  //    쇼다운 이후로 한정한다. `calculateSidePots`는 페이즈 전환에만 돌아서
  //    라운드 중간의 폴드는 다음 전환까지 목록에 반영되지 않는다. 지급에는
  //    영향이 없고(`resolveWinner`가 다시 계산한다), **딜러가 승자를 지명하는
  //    쇼다운 시점에는 정확하다** — 쇼다운 진입 자체가 재계산을 거치기 때문이다.
  //    그 정확성이 이 검사의 대상이다.
  if (state.phase >= GamePhase.SHOWDOWN) {
    const folded = state.players.filter(p => p?.hasFolded).map(p => p!.id);
    for (const pot of state.sidePots) {
      for (const id of folded) {
        expect(`${label}: ${id} 자격 ${pot.relevantPlayerIds.includes(id)}`)
          .toBe(`${label}: ${id} 자격 false`);
      }
    }
  }

  // 4. 베팅 중이라면 차례인 사람은 실재하고, 폴드하지 않았고, 올인이 아니다.
  const betting = [
    GamePhase.PRE_FLOP, GamePhase.FLOP, GamePhase.TURN, GamePhase.RIVER,
  ].includes(state.phase);
  if (betting && state.currentTurnSeatIndex !== -1) {
    const turn = state.players[state.currentTurnSeatIndex];
    expect(`${label}: 차례 ${turn?.id ?? '없음'}`).not.toBe(`${label}: 차례 없음`);
    expect(`${label}: 차례 폴드 ${turn?.hasFolded}`).toBe(`${label}: 차례 폴드 false`);
    expect(`${label}: 차례 올인 ${turn?.isAllIn}`).toBe(`${label}: 차례 올인 false`);
  }

  // 5. 쇼다운 이후에는 차례가 없다. 있으면 행동할 수 없는 사람의 화면에
  //    카운트다운이 돈다.
  if (state.phase >= GamePhase.SHOWDOWN) {
    expect(`${label}: 쇼다운 차례 ${state.currentTurnSeatIndex}`)
      .toBe(`${label}: 쇼다운 차례 -1`);
  }

  // 6. 좌석 비트맵과 스냅샷의 착석자가 일치한다.
  const bitmap = await h.redis.hget(
    `tournament:${h.tournamentId}:seat`, `table:${h.tableId}`,
  );
  const seatedInBitmap = (bitmap ?? '').split('').filter(c => c === '1').length;
  const seatedInState = state.players.filter(p => p !== null).length;
  expect(`${label}: 비트맵 ${seatedInBitmap}`).toBe(`${label}: 비트맵 ${seatedInState}`);

  return state;
}

/** 테이블 위 칩 총량. */
export function chipsOnTable(state: TableState): number {
  return state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0) + state.pot;
}

/** 열린 핸들을 정리한다. `close()`를 부르지 못하고 죽은 경우의 안전망. */
export async function forceClose(): Promise<void> {
  if (!handles) return;
  await handles.queue.close();
  await handles.queueConnection.quit();
  await handles.redis.quit();
  await closeTestPrisma(handles.prisma);
  handles = null;
}
