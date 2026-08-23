import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GameType, TournamentStatus } from '@prisma/client';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { GamePhase } from 'src/game-engine/types';
import { SessionService } from './session.service';

/**
 * 세션 생성 시 블라인드 연결.
 *
 * Tournament.blindId는 BlindStructure를 가리키는 FK다. 그런데 생성 경로에는
 * "기존 블라인드를 재사용"(dto.blindId)과 "새로 만들어 붙임"(blindStructure)
 * 두 갈래가 있고, 둘 다 선택 인자다 — 즉 아무것도 안 넘기는 호출이 타입상
 * 합법이다. 그 경우 무엇을 저장할지가 이 테스트의 대상이다.
 *
 * DB가 없어도 검증할 수 있는 이유는, 올바른 동작이 "거부"이기 때문이다.
 * FK 위반을 DB에게 물어보는 게 아니라 애초에 트랜잭션까지 가지 않아야 한다.
 */
describe('SessionService.createSession', () => {
  /** 목 상점 `store-1`의 주인. 소유권 검사(T56)를 통과하는 호출자다. */
  const OWNER = 'owner-1';

  const baseDto = (): CreateTournamentDto => ({
    name: '테스트 토너먼트',
    type: GameType.TOURNAMENT,
    storeId: 'store-1',
    startStack: 30000,
    entryFee: 10000,
    rebuyUntil: 5,
    isRegistrationOpen: true,
    prizePayouts: [
      { place: 1, percent: 50 },
      { place: 2, percent: 30 },
      { place: 3, percent: 20 },
    ],
  });

  const setup = () => {
    const tournamentCreate = jest.fn().mockResolvedValue({ id: 'tournament-1' });
    const blindCreate = jest.fn().mockResolvedValue({ id: 'blind-new' });

    const tx = {
      tournament: {
        create: tournamentCreate,
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'tournament-1', tables: [{ id: 'table-1' }] }),
      },
      dealerSession: { create: jest.fn().mockResolvedValue({ id: 'dealer-1' }) },
      table: { create: jest.fn().mockResolvedValue({ id: 'table-1' }) },
    };

    const prisma = {
      // 소유권 검사(T56)가 보는 두 행. 여기서는 전부 `store-1`을 가리키게
      // 두어 검사를 통과시킨다 — 어긋나는 입력을 거부하는지는 DB가 있어야
      // 의미가 있어서 `tenant-isolation.int-spec.ts`가 본다.
      store: { findUnique: jest.fn().mockResolvedValue({ ownerId: OWNER }) },
      blindStructure: {
        create: blindCreate,
        findUnique: jest.fn().mockResolvedValue({ storeId: 'store-1' }),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const redis = {
      setSeatBitmap: jest.fn().mockResolvedValue(undefined),
      saveSnapshotUnlocked: jest.fn().mockResolvedValue(undefined),
    };

    const service = new SessionService(
      prisma as any, redis as any, {} as any, { emit: jest.fn() } as any,
    );
    return { service, prisma, redis, tournamentCreate, blindCreate };
  };

  const blindStructure = () => ({
    name: '기본 구조',
    storeId: 'store-1',
    structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
  });

  it('기존 블라인드 id를 넘기면 그대로 연결한다', async () => {
    const { service, tournamentCreate } = setup();

    await service.createSession({ ...baseDto(), blindId: 'blind-existing' }, OWNER);

    expect(tournamentCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-existing');
  });

  it('블라인드 구조를 넘기면 새로 만들어 연결한다', async () => {
    const { service, tournamentCreate, blindCreate } = setup();

    await service.createSession(baseDto(), OWNER, blindStructure());

    expect(blindCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-new');
  });

  /**
   * 목을 채우기만 하면 이 호출이 사라져도 스펙이 초록이다. **무엇을 저장했는지
   * 까지 단언한다** — T38에서 목과 실제가 갈라진 자리라 같은 실수를 반복하지
   * 않는다.
   */
  it('1번 테이블의 빈 스냅샷을 좌석 비트맵과 함께 세운다', async () => {
    const { service, redis } = setup();

    await service.createSession({ ...baseDto(), blindId: 'blind-existing' }, OWNER);

    expect(redis.setSeatBitmap).toHaveBeenCalledWith('tournament-1', 'table-1');
    expect(redis.saveSnapshotUnlocked).toHaveBeenCalledTimes(1);
    const [tableId, state] = redis.saveSnapshotUnlocked.mock.calls[0];
    expect(tableId).toBe('table-1');
    expect(state.tournamentId).toBe('tournament-1');
    expect(state.phase).toBe(GamePhase.WAITING);
    expect(state.players).toHaveLength(9);
    expect(state.players.filter((p: unknown) => p !== null)).toHaveLength(0);
  });

  it('블라인드 정보가 아예 없으면 생성을 거부한다', async () => {
    // 거부하지 않으면 자리 채우기용 기본값이 그대로 FK로 저장된다. 운이 좋으면
    // 외래키 에러로 즉시 죽고, 운이 나쁘면 생성은 성공한 뒤 startSession의
    // game.blindStructure.structure 접근에서 죽는다 — 참가자가 다 앉은 다음에.
    const { service, prisma, tournamentCreate } = setup();

    await expect(service.createSession(baseDto(), OWNER)).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tournamentCreate).not.toHaveBeenCalled();
  });

  it('거부는 400이지 500이 아니다', async () => {
    // T11. `throw new Error`는 HTTP 경로에서 전부 500이 된다. 500은 "서버가
    // 고장났다"는 뜻이라 상점 운영자는 자기가 뭘 잘못 넣었는지 알 수 없고,
    // 프론트도 재시도할 요청과 고쳐서 보낼 요청을 구분할 수 없다.
    const { service } = setup();

    await expect(service.createSession(baseDto(), OWNER)).rejects.toThrow(BadRequestException);
  });

  describe('상금 분배율', () => {
    // 상금은 참가비에서 나온다. 비율을 대회마다 상점이 정하므로, 코드가
    // 기본값을 지어내면 아무도 합의하지 않은 비율로 돈이 나간다.

    it('분배율을 그대로 저장한다', async () => {
      const { service, tournamentCreate } = setup();

      await service.createSession({ ...baseDto(), blindId: 'blind-1' }, OWNER);

      expect(tournamentCreate.mock.calls[0][0].data.prizePayouts).toEqual([
        { place: 1, percent: 50 },
        { place: 2, percent: 30 },
        { place: 3, percent: 20 },
      ]);
    });

    it('itmCount는 분배율에서 파생된다', async () => {
      // 따로 받으면 둘이 어긋날 수 있다. itmCount 5에 분배율 3개면 4·5위는
      // 인 더 머니인데 받을 몫이 없다 — 어느 쪽이 맞는지 코드가 못 정한다.
      const { service, tournamentCreate } = setup();

      await service.createSession({
        ...baseDto(),
        blindId: 'blind-1',
        prizePayouts: [
          { place: 1, percent: 60 },
          { place: 2, percent: 40 },
        ],
      }, OWNER);

      expect(tournamentCreate.mock.calls[0][0].data.itmCount).toBe(2);
    });

    it('합이 100이 아니면 트랜잭션까지 가지 않고 400이다', async () => {
      const { service, prisma } = setup();

      await expect(service.createSession({
        ...baseDto(),
        blindId: 'blind-1',
        prizePayouts: [{ place: 1, percent: 90 }],
      }, OWNER)).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('분배율이 아예 없으면 거부한다', async () => {
      // 기본값을 두지 않는다. 대회를 못 만드는 편이, 모르는 비율로 돈이
      // 나가는 것보다 낫다.
      const { service, prisma } = setup();

      await expect(service.createSession({
        ...baseDto(),
        blindId: 'blind-1',
        prizePayouts: [],
      }, OWNER)).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

describe('SessionService HTTP 에러 타입', () => {
  // T11. 이 서비스는 상점 관리 화면이 REST로 부른다. 던지는 예외의 종류가
  // 그대로 상태 코드가 되고, 그게 사용자에게 보이는 안내를 가른다.
  //
  // DB 없이 검증할 수 있는 이유는 전부 "거부"라서다 — 트랜잭션까지 가지 않는다.

  const setup = (overrides: Record<string, unknown> = {}) => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
      ...overrides,
    };
    return new SessionService(
      prisma as any, { setSeatBitmap: jest.fn() } as any, {} as any, { emit: jest.fn() } as any,
    );
  };

  it('없는 세션에 테이블을 추가하면 404다', async () => {
    // 오타 난 id로 요청한 것과 서버가 죽은 것은 다른 일이다. 500이면 운영자가
    // 계속 재시도하고, 로그에는 같은 스택만 쌓인다.
    await expect(setup().createTable('없는-토너먼트', '아무개')).rejects.toThrow(NotFoundException);
  });

  it('종료된 세션을 수정하려 하면 409다', async () => {
    // 요청 자체는 올바른 형식이고, 대상의 현재 상태가 거부 이유다. 400이 아니라
    // 409여야 프론트가 "지금은 안 된다"로 안내할 수 있다.
    //
    // `store.ownerId`까지 세우는 이유는 T50이 소유권 확인을 이 메서드의 첫
    // 문장으로 넣었기 때문이다. 소유자가 아니면 403이 먼저 나가 이 409에
    // 닿지 못한다 — **본인 소유인데도 닫혀서 거부되는 것**이 여기서 볼 것이다.
    const service = setup({
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          status: TournamentStatus.FINISHED,
          store: { ownerId: 'owner-1' },
        }),
        update: jest.fn(),
      },
    });

    await expect(
      service.updateSession('t1', {} as any, 'owner-1'),
    ).rejects.toThrow(ConflictException);
  });
});

describe('SessionService.completeSession — 정산 게이트', () => {
  /** 목 대회 `t1`이 속한 상점의 주인. 소유권 검사(T56)를 통과하는 호출자다. */
  const OWNER = 'owner-1';

  /**
   * 대회를 닫는 것은 **되돌릴 수 없는 일**이다. 테이블과 딜러 세션을 지우고
   * Redis를 비운다. 그 뒤에는 누가 몇 등이었는지, 얼마를 받아야 했는지
   * 재구성할 근거가 남지 않는다.
   *
   * 그래서 정산이 끝난 뒤에만 닫힌다. 걷은 참가비(`totalBuyinAmount`)와 나간
   * 상금의 합이 같아야 한다 — 대회 하나의 회계가 맞아떨어졌다는 뜻이다.
   *
   * 마무리가 수동인 것은 설계다. ICM 찹으로 끝나는 대회가 있어서 최후 1인이
   * 나오기 전에 관리자가 정산할 수 있어야 한다. 이 게이트는 그 자유를 막지
   * 않는다 — 어떻게 나눴든 **합이 맞으면** 통과한다.
   */

  const setup = (opts: {
    pool: number;
    prizes: number[];
    status?: TournamentStatus;
    rakePercent?: number;
  }) => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          name: '테스트 대회',
          status: opts.status ?? TournamentStatus.ONGOING,
          totalBuyinAmount: opts.pool,
          rakePercent: opts.rakePercent ?? 0,
          storeId: 'store-1',
          // 소유권 검사(T56)가 보는 것. 같은 `findUnique` 목이 검사와 본문
          // 양쪽에 답하므로 두 모양을 한 행에 겹쳐 둔다.
          store: { ownerId: OWNER },
        }),
        update: jest.fn(),
      },
      tournamentParticipation: {
        findMany: jest.fn().mockResolvedValue(
          opts.prizes.map((prizeAmount, i) => ({ userId: `u${i}`, prizeAmount })),
        ),
      },
      store: { findUniqueOrThrow: jest.fn().mockResolvedValue({ ownerId: OWNER }) },
      table: { findMany: jest.fn().mockResolvedValue([{ id: 'table-1' }]) },
      // 문지기가 이겼다는 뜻이다. 지는 쪽은 통합 스펙이 경합으로 본다 —
      // 여기서는 게이트 산수만 잰다.
      $transaction: jest.fn().mockResolvedValue(true),
    };
    const redis = { deleteTournament: jest.fn() };
    return {
      service: new SessionService(
        prisma as any, redis as any, {} as any, { emit: jest.fn() } as any,
      ),
      prisma,
      redis,
    };
  };

  it('상금이 한 푼도 안 나갔으면 닫지 않는다', async () => {
    const { service, prisma, redis } = setup({ pool: 30000, prizes: [0, 0, 0] });

    await expect(service.completeSession('t1', OWNER)).rejects.toThrow(ConflictException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.deleteTournament).not.toHaveBeenCalled();
  });

  it('덜 나갔으면 얼마가 남았는지 알려준다', async () => {
    // 운영자가 화면에서 뭘 해야 하는지 알아야 한다. "닫을 수 없습니다"만으로는
    // 다시 누르는 것 말고 할 수 있는 일이 없다.
    const { service } = setup({ pool: 30000, prizes: [18000] });

    await expect(service.completeSession('t1', OWNER)).rejects.toThrow(/12000/);
  });

  /**
   * **레이크가 있으면 상금은 프라이즈풀만큼만 나간다.** 게이트가 상금만 보면
   * 상점 몫이 「남은 돈」으로 읽혀 대회가 영영 안 닫힌다.
   *
   * 위의 「합이 맞으면 닫는다」와 짝이다 — 그쪽은 레이크 0, 이쪽은 10%라
   * **둘이 어긋나는 입력**이다. `rake` 항을 지우면 이 검사만, 잘못된 부호로
   * 넣으면 저 검사만 터진다.
   */
  it('레이크가 있으면 상금이 프라이즈풀만큼만 나가도 닫는다', async () => {
    // 30,000의 10%인 3,000이 상점 몫이고 상금은 27,000이다.
    const { service, prisma } = setup({ pool: 30000, prizes: [27000], rakePercent: 10 });

    await service.completeSession('t1', OWNER);

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('레이크가 있는데 걷은 총액만큼 나갔으면 초과 지급이다', async () => {
    // 레이크를 빼면 프라이즈풀이 27,000인데 30,000이 나갔다.
    const { service, prisma } = setup({ pool: 30000, prizes: [30000], rakePercent: 10 });

    await expect(service.completeSession('t1', OWNER)).rejects.toThrow(/3000/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('더 나갔어도 닫지 않는다', async () => {
    // 초과 지급은 부족보다 나쁘다. 이미 나간 돈이라 회수할 근거가 없다.
    const { service, prisma } = setup({ pool: 30000, prizes: [40000] });

    await expect(service.completeSession('t1', OWNER)).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('합이 맞으면 닫는다 — 어떻게 나눴든 상관없다', async () => {
    // 찹으로 3등분한 대회도 통과해야 한다. 분배율대로인지 묻지 않는다.
    const { service, prisma, redis } = setup({ pool: 30000, prizes: [10000, 10000, 10000] });

    await service.completeSession('t1', OWNER);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(redis.deleteTournament).toHaveBeenCalled();
  });

  it('이미 닫힌 대회를 또 닫지 않는다', async () => {
    const { service, prisma } = setup({
      pool: 30000, prizes: [30000], status: TournamentStatus.FINISHED,
    });

    await expect(service.completeSession('t1', OWNER)).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('없는 대회는 404다', async () => {
    const prisma = {
      tournament: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const service = new SessionService(
      prisma as any, {} as any, {} as any, { emit: jest.fn() } as any,
    );

    await expect(service.completeSession('없는-대회', 'owner-1')).rejects.toThrow(NotFoundException);
  });
});

describe('SessionService.startSession', () => {
  /**
   * T16. `initializeGame`은 준비, `startSession`은 실제 시작이라는 구분이 원래
   * 의도였다. 그런데 준비 단계가 DB에 "시작했다"를 커밋하고 있었다 —
   * `startedAt` 기록과 참가자 `PLAYING` 전환.
   *
   * 순서가 뒤집혀 있으면 Redis가 실패했을 때 DB만 "진행 중"으로 남고 되돌릴 수
   * 없다. 이미 커밋된 뒤다. 웹이 읽는 것은 DB이므로, 참가자에게는 시작한 것으로
   * 보이는데 실제 게임 상태는 어디에도 없다.
   *
   * 되돌릴 수 있는 일(Redis)을 먼저 하고 커밋을 마지막에 한다. 그러면 커밋
   * 한 번이 "시작했다"는 단일 순간이 되고, 그 전에 실패하면 PENDING으로 남아
   * 시작 버튼을 다시 누르는 것이 곧 재시도가 된다.
   */
  const OWNER_ID = 'owner-1';

  const gameRow = (tables: unknown[]) => ({
    id: 't1',
    name: 'T',
    isRegistrationOpen: true,
    totalPlayers: 6,
    activePlayers: 6,
    entryFee: 1000,
    rebuyUntil: 5,
    avgStack: 10000,
    startStack: 10000,
    itmCount: 3,
    totalBuyinAmount: 6000,
    prizePayouts: [{ place: 1, percent: 100 }],
    blindStructure: { structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }] },
    // `assertTournamentOwnership`도 같은 mock `findUnique`를 타므로 store를
    // 함께 담는다 — mock은 select를 해석하지 않고 통째로 돌려준다.
    store: { ownerId: OWNER_ID },
    tables,
  });

  const setup = (opts: { tables?: unknown[]; snapshot?: unknown; redisError?: Error } = {}) => {
    const tables = opts.tables ?? [{ id: 'table-1', tablePlayers: [{ seatPosition: 0 }] }];

    const update = jest.fn().mockResolvedValue({});
    const tableUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      tournament: { findUnique: jest.fn().mockResolvedValue(gameRow(tables)), update },
      $transaction: jest.fn(async (fn: any) =>
        typeof fn === 'function'
          ? fn({
              tournament: { update },
              tournamentParticipation: { updateMany: jest.fn() },
              table: { update: tableUpdate },
            })
          : undefined,
      ),
    };

    const setTournamentMeta = jest.fn().mockResolvedValue(undefined);
    const stored = 'snapshot' in opts ? opts.snapshot : { players: [], buttonUser: 0 };
    // `mutateSnapshot`의 계약만 흉내 낸다 — 읽은 상태를 `fn`에 넘기고, `fn`이
    // 돌려준 것이 저장된 상태다. `null`을 돌려주면 쓰지 않고 읽은 것을 준다.
    // 락 자체가 실제로 도는지는 통합 계층이 본다(스냅샷 읽기·쓰기가 한 락 안에
    // 있는지는 목으로 증명되지 않는다).
    const mutateSnapshot = jest.fn(async (_tableId: string, fn: any) => {
      if (opts.redisError) throw opts.redisError;
      return (await fn(stored)) ?? stored;
    });
    const redis = { setTournamentMeta, mutateSnapshot };

    const service = new SessionService(
      prisma as any, redis as any, {} as any, { emit: jest.fn() } as any,
    );
    return { service, prisma, update, tableUpdate, setTournamentMeta, mutateSnapshot };
  };

  /**
   * 리뷰 finding(Minor 3): `tableUpdate` 목이 트랜잭션이 죽지 않게 하는
   * 스캐폴딩으로만 쓰이고 어떤 테스트도 그 호출을 단언하지 않았다. "시작
   * 트랜잭션이 버튼을 쓴다"를 단위 계층에서 한 줄로 볼 수 있는데 쓰지 않은
   * 셈이다(제품 코드 자체는 통합 테스트가 이미 덮는다).
   */
  it('시작 트랜잭션이 테이블의 buttonUser를 쓴다', async () => {
    const { service, tableUpdate } = setup();

    await service.startSession('t1', OWNER_ID);

    // 기본 seed: 테이블 하나, 좌석 하나(seatPosition 0) — 뽑을 수 있는
    // 버튼이 0 하나뿐이라 결정적이다.
    expect(tableUpdate).toHaveBeenCalledWith({
      where: { id: 'table-1' },
      data: { buttonUser: 0 },
    });
  });

  it('사람이 앉은 테이블에 스냅샷이 없으면 시작을 거부한다', async () => {
    // 조용히 빼고 진행하면 그 테이블만 상태 없이 시작한다. DB에는 사람이 앉아
    // 있고 PLAYING인데, 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를
    // 이유도 모른 채 본다.
    const { service } = setup({ snapshot: null });

    await expect(service.startSession('t1', OWNER_ID)).rejects.toThrow();
  });

  it('거부되면 DB에 아무것도 커밋하지 않는다', async () => {
    // 예전에는 스냅샷이 하나도 없어도 startSession이 성공을 반환하고 ONGOING이
    // 됐다. 대시보드도 블라인드도 없는 채로 시작된 대회가 남는다.
    const { service, prisma, update } = setup({ snapshot: null });

    await expect(service.startSession('t1', OWNER_ID)).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('Redis 저장이 실패하면 DB 커밋이 일어나지 않는다', async () => {
    // 순서의 요점. Redis는 아직 아무도 보지 않는 상태라 실패해도 되돌릴 것이
    // 없다. 커밋이 뒤에 있어야 이 성질이 성립한다.
    //
    // **실패가 조용히 성공처럼 보이지 않는다**도 여기서 지켜진다. 예전 경로
    // (`saveInitialTableSnapshots`)는 `pipeline.exec()`을 썼는데 그것은 명령이
    // 실패해도 던지지 않아서, 결과 배열을 직접 읽어 던져 주는 코드가 따로
    // 필요했다. 지금은 `mutateSnapshot` 한 번에 스냅샷 하나라 실패가 그대로
    // 거절된 프로미스로 올라온다.
    //
    // 목이 던지는 것은 **그 경로에서 실제로 나올 수 있는 것**이어야 한다.
    // ioredis가 끊긴 커넥션에 명령을 보낼 때 내는 문구를 쓴다 — 지워진
    // 메서드의 문구를 계속 던지면 아무 데도 없는 문자열을 검증하게 된다.
    const { service, prisma, update } = setup({
      redisError: new Error('Connection is closed.'),
    });

    // 인프라 오류는 **그대로** 올라간다. 아래 락 실패처럼 409로 번역하면
    // 진짜 장애가 "잠시 후 다시"로 위장된다.
    await expect(service.startSession('t1', OWNER_ID)).rejects.toThrow(/Connection is closed/);
    await expect(service.startSession('t1', OWNER_ID)).rejects.not.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * T61이 새로 연 실패 모드. 준비가 테이블 락을 잡게 되면서 `withTableLock`의
   * 5초 대기가 시작 경로에 들어왔다.
   *
   * 도달 경로가 실재한다 — `releaseSeats`는 `SELECT ... FOR UPDATE` 대기 때문에
   * 5초를 넘길 수 있다고 `domain.md`가 명시적으로 감수한 자리라, 좌석 해제 중에
   * 상점이 시작을 누르면 이 갈래다. 그대로 두면 500에 "락 획득 실패"가 나가는데,
   * **상점 콘솔에 "락"은 없는 말이다**(`domain.md`의 「상점도 손님이다」).
   */
  it('락을 못 잡으면 상점이 할 수 있는 일로 바꿔 던진다', async () => {
    const { service, prisma, update } = setup({
      redisError: new Error('테이블 table-1 락 획득 실패'),
    });

    await expect(service.startSession('t1', OWNER_ID)).rejects.toThrow(ConflictException);
    await expect(service.startSession('t1', OWNER_ID)).rejects.toThrow(/잠시 후 다시 시작/);

    // 다시 누르는 것이 곧 재시도인 상황이므로 아무것도 커밋되지 않아야 한다.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('Redis 준비가 끝난 뒤에야 DB를 커밋한다', async () => {
    // 웹이 읽는 것은 DB다. 참가자에게 "시작했다"가 보이는 시점이 실제 게임
    // 상태가 존재하는 시점보다 앞서면 안 된다.
    const order: string[] = [];
    const { service, prisma, setTournamentMeta, mutateSnapshot } = setup();
    setTournamentMeta.mockImplementation(async () => { order.push('meta'); });
    mutateSnapshot.mockImplementation(async (_tableId: string, fn: any) => {
      order.push('snapshots');
      const stored = { players: [], buttonUser: 0 };
      return (await fn(stored)) ?? stored;
    });
    prisma.$transaction.mockImplementation(async () => { order.push('commit'); });

    await service.startSession('t1', OWNER_ID);

    // **지키는 것은 "Redis 준비 둘이 DB 커밋보다 먼저"다.** 메타와 스냅샷의
    // 앞뒤는 그 성질이 아니라 별개의 규칙이다 — 메타가 스냅샷 뒤인 이유는
    // `initializeGame`의 `setTournamentMeta` 자리 주석에 있다(거부되는 시작은
    // 메타를 남기지 않는다).
    expect(order).toEqual(['snapshots', 'meta', 'commit']);
  });

  it('Redis 블라인드 기준 시각과 DB의 startedAt이 같다', async () => {
    // 블라인드 레벨은 startedAt으로부터의 경과 시간으로 계산된다. 예전에는
    // initializeGame과 startSession이 각각 시각을 찍어 둘이 어긋났다. 지금은
    // Redis만 읽어서 티가 안 나지만, 복구 경로가 DB의 startedAt을 읽는 순간
    // 다른 레벨이 나온다.
    const { service, update, setTournamentMeta } = setup();

    await service.startSession('t1', OWNER_ID);

    const blindField = setTournamentMeta.mock.calls[0][2];
    const written = update.mock.calls
      .map(c => c[0].data.startedAt)
      .filter(Boolean)
      .map((d: Date) => new Date(d).getTime());

    // 하나여야 한다. 두 번 찍으면 그 자체가 어긋남이다.
    expect(written).toEqual([blindField.startedAt]);
  });
});

describe('SessionService 시작 최소 인원', () => {
  /**
   * 코드에 박힌 2는 제품 규칙이 아니라 **수동 테스트 편의**였다. 크롬 창을
   * 6개 띄우고 각각 로그인하는 데 드는 시간이 커서 임의로 낮춰둔 값이다.
   *
   * 그래서 2를 6으로 바꾸는 것은 답이 아니다. 로컬에서 다시 못 돌리게 된다.
   * 환경으로 빼되 **기본값은 운영 규칙(6)**이어야 한다 — 기본값을 테스트
   * 편의값으로 두면 설정을 빠뜨린 배포가 조용히 2로 뜬다. T10의
   * `JWT_SECRET='super-secret'`과 같은 실수다.
   */
  const OWNER_ID = 'owner-1';

  const setup = (totalPlayers: number) => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          name: 'T',
          isRegistrationOpen: true,
          totalPlayers,
          activePlayers: totalPlayers,
          entryFee: 1000,
          rebuyUntil: 5,
          avgStack: 10000,
          startStack: 10000,
          itmCount: 3,
          totalBuyinAmount: 1000 * totalPlayers,
          prizePayouts: [{ place: 1, percent: 100 }],
          blindStructure: { structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }] },
          // `assertTournamentOwnership`도 이 mock을 탄다 — select를 해석하지
          // 않고 통째로 돌려주므로 store를 같이 담아 둔다.
          store: { ownerId: OWNER_ID },
          tables: [],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) =>
        typeof fn === 'function'
          ? fn({
              tournament: { update: jest.fn().mockResolvedValue({ id: 't1' }) },
              tournamentParticipation: { updateMany: jest.fn() },
            })
          : undefined,
      ),
    };
    const redis = {
      setTournamentMeta: jest.fn().mockResolvedValue(undefined),
      mutateSnapshot: jest.fn().mockResolvedValue(null),
    };
    return new SessionService(
      prisma as any, redis as any, {} as any, { emit: jest.fn() } as any,
    );
  };

  afterEach(() => {
    delete process.env.MIN_PLAYERS_TO_START;
  });

  it('기본값은 6이다', async () => {
    await expect(setup(5).startSession('t1', OWNER_ID)).rejects.toThrow(ConflictException);
    await expect(setup(6).startSession('t1', OWNER_ID)).resolves.toBeDefined();
  });

  it('환경변수가 기본값을 이기고, 호출 시점에 읽는다', async () => {
    // 낮추는 쪽은 수동 테스트용이다 — 크롬 창을 두 개만 띄우고 돌리기 위한 것.
    process.env.MIN_PLAYERS_TO_START = '2';
    await expect(setup(2).startSession('t1', OWNER_ID)).resolves.toBeDefined();

    // 올리는 쪽까지 봐야 값을 실제로 읽는지 알 수 있다. 낮추는 쪽만 보면
    // 하드코딩된 2와 결과가 같아 변화를 못 본다.
    process.env.MIN_PLAYERS_TO_START = '9';
    await expect(setup(3).startSession('t1', OWNER_ID)).rejects.toThrow(ConflictException);

    // 모듈 로드 시점에 고정하면 테스트가 값을 바꿀 수 없다 — `rebuyTimeoutMs`와
    // 같은 이유로 호출 시점에 읽는다. 이 describe가 값을 바꿔가며 도는 것 자체가
    // 그 검증이다.
  });
});

/**
 * 테이블 추가는 남의 대회를 건드릴 수 없다.
 *
 * 소유권 검사를 컨트롤러가 아니라 서비스 메서드 첫 문장에 두는 이유는
 * assertTournamentOwnership의 주석에 있다 — 컨트롤러에만 있으면 서비스를
 * 직접 부르는 경로가 우회한다.
 */
describe('SessionService.createTable — 소유권과 상태', () => {
  const setup = (opts: {
    ownerId?: string;
    status?: TournamentStatus;
    hasDealerSession?: boolean;
  } = {}) => {
    const tournament = {
      id: 'tournament-1',
      status: opts.status ?? TournamentStatus.PENDING,
      store: { ownerId: opts.ownerId ?? 'owner-1' },
      dealerSession: opts.hasDealerSession === false ? null : { id: 'dealer-1' },
    };
    const tableCreate = jest.fn().mockResolvedValue({ id: 'table-2', tableOrder: 2 });
    const prisma = {
      tournament: { findUnique: jest.fn().mockResolvedValue(tournament) },
      $transaction: jest.fn((fn: (t: any) => unknown) =>
        fn({
          table: {
            // 개수가 아니라 최댓값에서 다음 번호를 뽑는다. 삭제가 번호를
            // 재정렬하지 않아 1·3만 남는 대회가 생기기 때문이다.
            aggregate: jest.fn().mockResolvedValue({ _max: { tableOrder: 1 } }),
            create: tableCreate,
          },
        }),
      ),
    };
    const redis = {
      setSeatBitmap: jest.fn().mockResolvedValue(undefined),
      saveSnapshotUnlocked: jest.fn().mockResolvedValue(undefined),
      // emitSeatList가 브로드캐스트할 좌석 목록을 읽어온다. 이 스위트가 보는
      // 것은 이벤트가 나가는지 여부라, 내용물은 비워 둔다.
      getTournamentTables: jest.fn().mockResolvedValue([]),
    };
    const emitter = { emit: jest.fn() };
    const service = new SessionService(
      prisma as any, redis as any, {} as any, emitter as any,
    );
    return { service, tableCreate, emitter, redis };
  };

  it('남의 대회면 403이고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ ownerId: 'someone-else' });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('FINISHED 대회면 409고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ status: TournamentStatus.FINISHED });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ConflictException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('딜러 세션이 없으면 409고 테이블을 만들지 않는다', async () => {
    const { service, tableCreate } = setup({ hasDealerSession: false });

    await expect(service.createTable('tournament-1', 'owner-1')).rejects.toThrow(
      ConflictException,
    );
    expect(tableCreate).not.toHaveBeenCalled();
  });

  it('성공하면 SEAT_LIST_UPDATED를 낸다', async () => {
    const { service, emitter } = setup();

    await service.createTable('tournament-1', 'owner-1');

    expect(emitter.emit).toHaveBeenCalledWith(
      'SEAT_LIST_UPDATED',
      expect.objectContaining({ tournamentId: 'tournament-1' }),
    );
  });

  /**
   * 저장 여부만 보면 목이 실제와 갈라진다 — 무엇을 저장했는지까지 본다.
   *
   * 그리고 **순서가 요건이다.** 브로드캐스트를 보고 들어오는 화면이 상태를
   * 찾지 못하면 안 되므로, 스냅샷 쓰기가 `SEAT_LIST_UPDATED`보다 앞서야 한다.
   */
  it('빈 스냅샷을 먼저 세우고 그 다음에 좌석 목록을 알린다', async () => {
    const { service, emitter, redis } = setup();

    await service.createTable('tournament-1', 'owner-1');

    expect(redis.saveSnapshotUnlocked).toHaveBeenCalledWith(
      'table-2',
      expect.objectContaining({
        tournamentId: 'tournament-1',
        phase: GamePhase.WAITING,
        pot: 0,
        currentTurnSeatIndex: -1,
      }),
      // 락 없이 쓰는 예외임을 호출부가 이름과 이유로 자백한다(T42).
      'table-created',
    );
    const [, state] = redis.saveSnapshotUnlocked.mock.calls[0];
    expect(`좌석 ${state.players.length}`).toBe('좌석 9');
    expect(`착석자 ${state.players.filter((p: unknown) => p !== null).length}`)
      .toBe('착석자 0');

    const savedAt = redis.saveSnapshotUnlocked.mock.invocationCallOrder[0];
    const emittedAt = emitter.emit.mock.invocationCallOrder[0];
    expect(`스냅샷이 먼저 ${savedAt < emittedAt}`).toBe('스냅샷이 먼저 true');
  });
});
