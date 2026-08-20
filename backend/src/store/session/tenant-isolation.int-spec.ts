import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GameType, PrismaClient, Role } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { OtpAttempts } from 'src/dealer/otp-attempts';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { closeTestPrisma, createTestPrisma, truncateAll } from '../../../test/helpers/prisma';
import { createTestRedis, flushTestRedis } from '../../../test/helpers/redis';
import { SessionService } from './session.service';

/**
 * 상점 경계(테넌트 분리).
 *
 * `assertTournamentOwnership`을 지나는 조작(시작·취소·테이블·좌석 해제·
 * 재발급·좌석 조회)은 이미 남의 대회를 거절한다. 여기서 보는 것은 **그 검사가
 * 아예 없던 세 자리**다 — 대회 생성·목록 조회·종료. 셋 다 상점 id나 대회 id를
 * 요청에서 그대로 받아 썼고, 호출자가 그 상점 주인인지 묻지 않았다.
 *
 * 목을 쓰지 않는 이유는 검사의 근거가 DB의 `Store.ownerId` 관계 자체라서다.
 * 목으로 두면 "무엇을 조회했는가"만 보게 되고, 정작 남의 행에 닿는지는 안 본다.
 */
describe('상점 경계 — 남의 상점을 건드릴 수 없다', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let sessionService: SessionService;

  /** 상점 A(공격자 쪽 호출자)와 상점 B(피해자). */
  let ownerA: string;
  let storeA: string;
  let blindA: string;
  let ownerB: string;
  let storeB: string;
  let blindB: string;

  beforeAll(() => {
    prisma = createTestPrisma();
    redis = createTestRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await closeTestPrisma(prisma);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await flushTestRedis(redis);

    sessionService = new SessionService(
      prisma as unknown as PrismaService,
      new RedisService(redis),
      new OtpAttempts(redis),
      new EventEmitter2(),
    );

    const a = await makeStore('A');
    ownerA = a.ownerId;
    storeA = a.storeId;
    blindA = a.blindId;

    const b = await makeStore('B');
    ownerB = b.ownerId;
    storeB = b.storeId;
    blindB = b.blindId;
  });

  async function makeStore(label: string) {
    const owner = await prisma.user.create({
      data: { nickname: `owner-${label}`, password: 'x', role: 'STORE_ADMIN' },
    });
    const store = await prisma.store.create({
      data: { name: `상점 ${label}`, ownerId: owner.id },
    });
    const blind = await prisma.blindStructure.create({
      data: {
        name: `구조 ${label}`,
        storeId: store.id,
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    });
    return { ownerId: owner.id, storeId: store.id, blindId: blind.id };
  }

  const makeDto = (storeId: string, blindId: string): CreateTournamentDto => ({
    name: '대회',
    type: GameType.TOURNAMENT,
    storeId,
    blindId,
    startStack: 10000,
    entryFee: 1000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [{ place: 1, percent: 100 }],
  });

  /**
   * blindId 없이 blindStructure를 넘기는 호출용 기본 dto. `storeId`는 호출부에서
   * 덮어쓰고, `blindId`는 일부러 비워 `createSession`이 세 번째 인자로 새
   * 블라인드 구조를 만들게 한다.
   */
  const baseDto: Omit<CreateTournamentDto, 'storeId' | 'blindId'> = {
    name: '대회',
    type: GameType.TOURNAMENT,
    startStack: 10000,
    entryFee: 1000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [{ place: 1, percent: 100 }],
  };

  describe('createSession', () => {
    it('남의 상점 id로는 대회를 만들 수 없다', async () => {
      await expect(
        sessionService.createSession(makeDto(storeB, blindB), ownerA),
      ).rejects.toThrow(ForbiddenException);

      await expect(prisma.tournament.count({ where: { storeId: storeB } })).resolves.toBe(0);
    });

    it('본인 상점이면 만들어진다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);

      await expect(prisma.tournament.count({ where: { storeId: storeA } })).resolves.toBe(1);
    });

    // 아래 둘은 **검사가 하나로는 부족하다**는 것을 보인다. 상점 id 하나만
    // 확인하면 통과하는 입력이라, 두 값이 어긋나는 경우를 따로 먹인다.
    it('본인 상점 대회에 남의 블라인드 구조를 붙일 수 없다', async () => {
      await expect(
        sessionService.createSession(makeDto(storeA, blindB), ownerA),
      ).rejects.toThrow(ForbiddenException);
    });

    it('본인 상점 대회를 만들며 남의 상점에 블라인드 구조를 심을 수 없다', async () => {
      const dto = makeDto(storeA, undefined as unknown as string);
      delete (dto as { blindId?: string }).blindId;

      await expect(
        sessionService.createSession(dto, ownerA, {
          name: '심어진 구조',
          storeId: storeB,
          structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(prisma.blindStructure.count({ where: { storeId: storeB } })).resolves.toBe(1);
    });

    it('두 상점이 같은 이름의 블라인드 구조를 쓸 수 있다', async () => {
      // 전역 유니크였을 때는 두 번째 상점의 `POST /store/sessions`가 P2002로
      // 500이었다. 응답 차이로 다른 상점이 어떤 이름을 쓰는지 떠볼 수도 있었다.
      // `seed-load.ts`가 상점마다 이름에 인덱스를 붙인 것이 이 사실의 흔적이다.
      await sessionService.createSession(
        { ...baseDto, storeId: storeA } as CreateTournamentDto,
        ownerA,
        { name: '주말 딥스택', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
      );

      await expect(
        sessionService.createSession(
          { ...baseDto, storeId: storeB } as CreateTournamentDto,
          ownerB,
          { name: '주말 딥스택', storeId: storeB, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
        ),
      ).resolves.toBeDefined();
    });

    it('같은 상점 안에서는 이름이 겹치지 않는다', async () => {
      await sessionService.createSession(
        { ...baseDto, storeId: storeA } as CreateTournamentDto,
        ownerA,
        { name: '중복 이름', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
      );

      await expect(
        sessionService.createSession(
          { ...baseDto, storeId: storeA } as CreateTournamentDto,
          ownerA,
          { name: '중복 이름', storeId: storeA, structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] },
        ),
      ).rejects.toThrow();
    });
  });

  describe('getStoreAllSessions', () => {
    it('남의 상점 대회 목록은 볼 수 없다', async () => {
      await sessionService.createSession(makeDto(storeB, blindB), ownerB);

      await expect(sessionService.getStoreAllSessions(storeB, ownerA)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('본인 상점 목록은 그대로 나온다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);

      const sessions = await sessionService.getStoreAllSessions(storeA, ownerA);

      expect(sessions).toHaveLength(1);
    });
  });

  describe('completeSession', () => {
    it('남의 대회는 종료할 수 없다 — 상금 지급이 걸린 경로다', async () => {
      await sessionService.createSession(makeDto(storeB, blindB), ownerB);
      const target = await prisma.tournament.findFirstOrThrow({ where: { storeId: storeB } });

      await expect(sessionService.completeSession(target.id, ownerA)).rejects.toThrow(
        ForbiddenException,
      );

      const after = await prisma.tournament.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.status).toBe(target.status);
    });

    it('본인 대회는 종료된다', async () => {
      await sessionService.createSession(makeDto(storeA, blindA), ownerA);
      const mine = await prisma.tournament.findFirstOrThrow({ where: { storeId: storeA } });

      await expect(sessionService.completeSession(mine.id, ownerA)).resolves.not.toThrow();
    });
  });
});

/**
 * 테이블 경계 — 대회·상점만이 아니라 **테이블도** 남의 자리다.
 *
 * `GET /playsync/:id`(`joinTable`)에는 `JwtAuthGuard`밖에 없었다 — 인증만
 * 되면 소유권·좌석·대회 소속을 아무것도 대조하지 않고 `getSnapShot`이 주는
 * 전체 스냅샷을 그대로 돌려줬다. WS는 같은 자원에 `assertTableAccess`를
 * 걸어 왔는데(딜러는 서명된 토큰의 tableId 대조, 플레이어는 실제 좌석 대조),
 * REST 쪽 문만 잠겨 있지 않았다(T66).
 *
 * 판정은 `PlaysyncService.assertTableAccess` 한 곳이고 REST·WS가 함께
 * 부른다 — 여기서는 그 판정 함수 자체를, `PlaysyncController`의 배선과
 * 별개로 진짜 Redis 스냅샷을 놓고 검증한다(`playsync.controller.int-spec.ts`는
 * 반대로 배선을 본다).
 */
describe('테이블 경계 — 남의 테이블 스냅샷을 볼 수 없다', () => {
  let redis: Redis;
  let playsync: PlaysyncService;

  const TABLE = 'boundary-table-1';
  const OTHER_TABLE = 'boundary-table-2';
  const TOURNAMENT = 'boundary-tournament-1';

  function makePlayer(id: string, seatIndex: number): TablePlayer {
    return {
      id,
      tableId: TABLE,
      nickname: id,
      seatIndex,
      stack: 10000,
      bet: 0,
      hasFolded: false,
      hasChecked: false,
      isAllIn: false,
      totalContributed: 0,
    };
  }

  function makeState(playerIds: string[]): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: playerIds.map((id, i) => makePlayer(id, i)),
      buttonUser: 0,
      currentTurnSeatIndex: 0,
      pot: 0,
      sidePots: [],
      currentBet: 0,
      smallBlind: 50,
      ante: 0,
      tournamentId: TOURNAMENT,
    };
  }

  beforeAll(() => {
    redis = createTestRedis();
    playsync = new PlaysyncService(
      {} as unknown as Queue,
      new RedisService(redis),
      {} as unknown as PrismaService,
      new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState(['alice'])));
  });

  it('앉지 않은 유저는 거부된다', async () => {
    await expect(
      playsync.assertTableAccess({ sub: 'mallory', role: Role.USER }, TABLE),
    ).rejects.toThrow(ForbiddenException);
  });

  it('앉은 유저는 통과한다', async () => {
    await expect(
      playsync.assertTableAccess({ sub: 'alice', role: Role.USER }, TABLE),
    ).resolves.toBeUndefined();
  });

  it('딜러는 토큰에 서명된 테이블이 아니면 거부된다', async () => {
    await redis.set(`table:state:${OTHER_TABLE}`, JSON.stringify(makeState(['bob'])));

    await expect(
      playsync.assertTableAccess(
        { sub: 'dealer-session-1', role: Role.DEALER, tableId: TABLE },
        OTHER_TABLE,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('딜러는 토큰에 서명된 테이블이면 좌석이 없어도 통과한다', async () => {
    await expect(
      playsync.assertTableAccess(
        { sub: 'dealer-session-1', role: Role.DEALER, tableId: TABLE },
        TABLE,
      ),
    ).resolves.toBeUndefined();
  });

  it('스냅샷이 없는 테이블은 존재 여부를 감추지 않고 404다', async () => {
    await expect(
      playsync.assertTableAccess({ sub: 'alice', role: Role.USER }, 'no-such-table'),
    ).rejects.toThrow(NotFoundException);
  });
});
