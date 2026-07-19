import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GameType, TournamentStatus } from '@prisma/client';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
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
  const baseDto = (): CreateTournamentDto => ({
    name: '테스트 토너먼트',
    type: GameType.TOURNAMENT,
    storeId: 'store-1',
    startStack: 30000,
    entryFee: 10000,
    rebuyUntil: 5,
    itmCount: 3,
    isRegistrationOpen: true,
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
      blindStructure: { create: blindCreate },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const redis = { setSeatBitmap: jest.fn().mockResolvedValue(undefined) };

    const service = new SessionService(prisma as any, redis as any);
    return { service, prisma, redis, tournamentCreate, blindCreate };
  };

  const blindStructure = () => ({
    name: '기본 구조',
    storeId: 'store-1',
    structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
  });

  it('기존 블라인드 id를 넘기면 그대로 연결한다', async () => {
    const { service, tournamentCreate } = setup();

    await service.createSession({ ...baseDto(), blindId: 'blind-existing' });

    expect(tournamentCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-existing');
  });

  it('블라인드 구조를 넘기면 새로 만들어 연결한다', async () => {
    const { service, tournamentCreate, blindCreate } = setup();

    await service.createSession(baseDto(), blindStructure());

    expect(blindCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-new');
  });

  it('블라인드 정보가 아예 없으면 생성을 거부한다', async () => {
    // 거부하지 않으면 자리 채우기용 기본값이 그대로 FK로 저장된다. 운이 좋으면
    // 외래키 에러로 즉시 죽고, 운이 나쁘면 생성은 성공한 뒤 startSession의
    // game.blindStructure.structure 접근에서 죽는다 — 참가자가 다 앉은 다음에.
    const { service, prisma, tournamentCreate } = setup();

    await expect(service.createSession(baseDto())).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tournamentCreate).not.toHaveBeenCalled();
  });

  it('거부는 400이지 500이 아니다', async () => {
    // T11. `throw new Error`는 HTTP 경로에서 전부 500이 된다. 500은 "서버가
    // 고장났다"는 뜻이라 상점 운영자는 자기가 뭘 잘못 넣었는지 알 수 없고,
    // 프론트도 재시도할 요청과 고쳐서 보낼 요청을 구분할 수 없다.
    const { service } = setup();

    await expect(service.createSession(baseDto())).rejects.toThrow(BadRequestException);
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
    return new SessionService(prisma as any, { setSeatBitmap: jest.fn() } as any);
  };

  it('없는 세션에 테이블을 추가하면 404다', async () => {
    // 오타 난 id로 요청한 것과 서버가 죽은 것은 다른 일이다. 500이면 운영자가
    // 계속 재시도하고, 로그에는 같은 스택만 쌓인다.
    await expect(setup().createTable('없는-토너먼트')).rejects.toThrow(NotFoundException);
  });

  it('종료된 세션을 수정하려 하면 409다', async () => {
    // 요청 자체는 올바른 형식이고, 대상의 현재 상태가 거부 이유다. 400이 아니라
    // 409여야 프론트가 "지금은 안 된다"로 안내할 수 있다.
    const service = setup({
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          status: TournamentStatus.FINISHED,
        }),
        update: jest.fn(),
      },
    });

    await expect(service.updateSession('t1', {} as any)).rejects.toThrow(ConflictException);
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
    blindStructure: { structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }] },
    tables,
  });

  const setup = (opts: { tables?: unknown[]; snapshot?: unknown; redisFails?: boolean } = {}) => {
    const tables = opts.tables ?? [{ id: 'table-1', tablePlayers: [{ seatPosition: 0 }] }];

    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      tournament: { findUnique: jest.fn().mockResolvedValue(gameRow(tables)), update },
      $transaction: jest.fn(async (fn: any) =>
        typeof fn === 'function'
          ? fn({ tournament: { update }, tournamentParticipation: { updateMany: jest.fn() } })
          : undefined,
      ),
    };

    const setTournamentMeta = jest.fn().mockResolvedValue(undefined);
    const saveInitialTableSnapshots = jest.fn(async () => {
      if (opts.redisFails) throw new Error('테이블 상태 저장에 실패했습니다: table-1');
    });
    const redis = {
      getSnapShot: jest.fn().mockResolvedValue(
        'snapshot' in opts ? opts.snapshot : { players: [], buttonUser: 0 },
      ),
      setTournamentMeta,
      saveInitialTableSnapshots,
    };

    const service = new SessionService(prisma as any, redis as any);
    return { service, prisma, update, setTournamentMeta, saveInitialTableSnapshots };
  };

  it('사람이 앉은 테이블에 스냅샷이 없으면 시작을 거부한다', async () => {
    // 조용히 빼고 진행하면 그 테이블만 상태 없이 시작한다. DB에는 사람이 앉아
    // 있고 PLAYING인데, 딜러는 첫 액션에서 '테이블 상태를 찾을 수 없습니다'를
    // 이유도 모른 채 본다.
    const { service } = setup({ snapshot: null });

    await expect(service.startSession('t1')).rejects.toThrow();
  });

  it('거부되면 DB에 아무것도 커밋하지 않는다', async () => {
    // 예전에는 스냅샷이 하나도 없어도 startSession이 성공을 반환하고 ONGOING이
    // 됐다. 대시보드도 블라인드도 없는 채로 시작된 대회가 남는다.
    const { service, prisma, update } = setup({ snapshot: null });

    await expect(service.startSession('t1')).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('Redis 저장이 실패하면 DB 커밋이 일어나지 않는다', async () => {
    // 순서의 요점. Redis는 아직 아무도 보지 않는 상태라 실패해도 되돌릴 것이
    // 없다. 커밋이 뒤에 있어야 이 성질이 성립한다.
    const { service, prisma, update } = setup({ redisFails: true });

    await expect(service.startSession('t1')).rejects.toThrow(/저장에 실패/);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('Redis 준비가 끝난 뒤에야 DB를 커밋한다', async () => {
    // 웹이 읽는 것은 DB다. 참가자에게 "시작했다"가 보이는 시점이 실제 게임
    // 상태가 존재하는 시점보다 앞서면 안 된다.
    const order: string[] = [];
    const { service, prisma, setTournamentMeta, saveInitialTableSnapshots } = setup();
    setTournamentMeta.mockImplementation(async () => { order.push('meta'); });
    saveInitialTableSnapshots.mockImplementation(async () => { order.push('snapshots'); });
    prisma.$transaction.mockImplementation(async () => { order.push('commit'); });

    await service.startSession('t1');

    expect(order).toEqual(['meta', 'snapshots', 'commit']);
  });

  it('Redis 블라인드 기준 시각과 DB의 startedAt이 같다', async () => {
    // 블라인드 레벨은 startedAt으로부터의 경과 시간으로 계산된다. 예전에는
    // initializeGame과 startSession이 각각 시각을 찍어 둘이 어긋났다. 지금은
    // Redis만 읽어서 티가 안 나지만, 복구 경로가 DB의 startedAt을 읽는 순간
    // 다른 레벨이 나온다.
    const { service, update, setTournamentMeta } = setup();

    await service.startSession('t1');

    const blindField = setTournamentMeta.mock.calls[0][2];
    const written = update.mock.calls
      .map(c => c[0].data.startedAt)
      .filter(Boolean)
      .map((d: Date) => new Date(d).getTime());

    // 하나여야 한다. 두 번 찍으면 그 자체가 어긋남이다.
    expect(written).toEqual([blindField.startedAt]);
  });
});
