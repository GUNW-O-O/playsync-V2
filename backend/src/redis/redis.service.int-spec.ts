import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 테이블 락은 진짜 Redis로만 검증할 수 있다.
 *
 * 검증 대상이 SET NX의 원자성 자체이므로, mock으로 바꾸면 테스트가 증명하려는
 * 성질이 사라진다.
 */
describe('RedisService.withTableLock', () => {
  let redis: Redis;
  let service: RedisService;

  const TABLE = 'table-1';
  const lockKey = (tableId: string) => `lock:table:state:${tableId}`;

  beforeAll(() => {
    redis = createTestRedis();
    service = new RedisService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  it('fn의 반환값을 그대로 돌려준다', async () => {
    const result = await service.withTableLock(TABLE, async () => 'done');

    expect(result).toBe('done');
  });

  it('같은 테이블에서는 한 번에 하나만 실행된다', async () => {
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      service.withTableLock(TABLE, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 150));
        running--;
      });

    await Promise.all([task(), task(), task()]);

    expect(maxRunning).toBe(1);
  });

  it('다른 테이블은 서로 막지 않는다', async () => {
    // 테이블 단위 락이므로 10테이블 토너먼트가 1테이블 속도로 떨어지면 안 된다.
    let running = 0;
    let maxRunning = 0;

    const task = (tableId: string) =>
      service.withTableLock(tableId, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 150));
        running--;
      });

    await Promise.all([task('table-a'), task('table-b')]);

    expect(maxRunning).toBe(2);
  });

  it('fn이 예외를 던져도 락을 해제한다', async () => {
    await expect(
      service.withTableLock(TABLE, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await redis.get(lockKey(TABLE))).toBeNull();
  });

  it('TTL이 만료된 뒤에는 다른 요청이 잡은 락을 해제하지 않는다', async () => {
    // TTL 100ms짜리 락을 쥐고 300ms 일한다 = 도중에 만료된다.
    const holder = service.withTableLock(
      TABLE,
      async () => {
        await new Promise((r) => setTimeout(r, 300));
      },
      100,
    );

    // 만료된 뒤 다른 요청이 같은 키를 잡는다.
    await new Promise((r) => setTimeout(r, 150));
    await redis.set(lockKey(TABLE), 'other-owner', 'PX', 5000);

    await holder;

    // 토큰 비교 없이 del을 부르면 여기서 null이 되고, 두 요청이 동시에
    // 임계 구역에 들어간 채로 아무도 눈치채지 못한다.
    expect(await redis.get(lockKey(TABLE))).toBe('other-owner');
  });

  it('대기 시간 안에 락을 못 잡으면 실패한다', async () => {
    const holder = service.withTableLock(
      TABLE,
      async () => {
        await new Promise((r) => setTimeout(r, 500));
      },
      5000,
    );

    await expect(
      service.withTableLock(TABLE, async () => 'never', 5000, 200),
    ).rejects.toThrow(/락/);

    await holder;
  });
});

/**
 * 좌석 비트맵의 원자성.
 *
 * 좌석 락은 좌석**별**이라 다른 좌석에 앉는 두 사람은 서로를 막지 않는다.
 * 즉 같은 비트맵에 대한 동시 수정은 예외가 아니라 기본 시나리오다.
 */
describe('RedisService.updateSeatBitmap', () => {
  let redis: Redis;
  let service: RedisService;

  const TOURNAMENT = 'tournament-1';
  const TABLE = 'table-1';
  const key = `tournament:${TOURNAMENT}:seat`;
  const field = `table:${TABLE}`;

  beforeAll(() => {
    redis = createTestRedis();
    service = new RedisService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await service.setSeatBitmap(TOURNAMENT, TABLE);
  });

  it('좌석을 점유하면 해당 비트만 선다', async () => {
    const result = await service.updateSeatBitmap(TOURNAMENT, TABLE, 3, true);

    expect(result).toBe('000100000');
    expect(await redis.hget(key, field)).toBe('000100000');
  });

  it('점유를 해제하면 해당 비트만 내려간다', async () => {
    await service.updateSeatBitmap(TOURNAMENT, TABLE, 3, true);

    const result = await service.updateSeatBitmap(TOURNAMENT, TABLE, 3, false);

    expect(result).toBe('000000000');
  });

  it('동시에 다른 좌석에 앉아도 비트가 유실되지 않는다', async () => {
    // hget → 문자열 수정 → hset이면 둘이 같은 비트맵을 읽고 각자 자기 비트만
    // 세팅해 저장한다. 나중에 쓴 쪽이 앞선 비트를 지운다. 실착석은 DB unique
    // 제약이 막아주므로 돈이 새지는 않지만, 예매 화면에 점유 좌석이 빈자리로
    // 보인다 — 앉을 수 없는 자리를 계속 클릭하게 된다.
    await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map(seat =>
        service.updateSeatBitmap(TOURNAMENT, TABLE, seat, true),
      ),
    );

    expect(await redis.hget(key, field)).toBe('111111111');
  });

  it('동시에 앉고 일어나도 각자의 비트만 바뀐다', async () => {
    await service.updateSeatBitmap(TOURNAMENT, TABLE, 8, true);

    await Promise.all([
      service.updateSeatBitmap(TOURNAMENT, TABLE, 0, true),
      service.updateSeatBitmap(TOURNAMENT, TABLE, 8, false),
      service.updateSeatBitmap(TOURNAMENT, TABLE, 4, true),
    ]);

    expect(await redis.hget(key, field)).toBe('100010000');
  });

  it('비트맵이 없던 테이블도 9칸으로 만들어 준다', async () => {
    await service.updateSeatBitmap(TOURNAMENT, 'table-unknown', 2, true);

    expect(await redis.hget(key, 'table:table-unknown')).toBe('001000000');
  });

  it('좌석 범위를 벗어나면 비트맵을 늘리지 않는다', async () => {
    // 배열 인덱스로 쓰면 bitmapArray[9] = '1'이 길이 10짜리 비트맵을 만든다.
    // getTournamentTables가 없는 좌석을 그려준다.
    await expect(
      service.updateSeatBitmap(TOURNAMENT, TABLE, 9, true),
    ).rejects.toThrow();

    expect(await redis.hget(key, field)).toBe('000000000');
  });
});

/**
 * 등록 마감(rebuyUntil) 처리.
 *
 * 마감은 "레벨이 바뀌는 순간"에만 검사된다. 그런데 레벨 계산은 저장된 상태가
 * 아니라 startedAt과 현재 시각으로부터 매번 다시 구해지므로, 서버가 잠깐
 * 죽었다 살아나거나 폴링이 밀리면 currentBlindLv가 한 번에 여러 칸 뛴다.
 * 마감 레벨을 정확히 밟지 않고 지나가는 것이 정상 시나리오라는 뜻이다.
 *
 * 진짜 Redis로 검증하는 이유는 마감 플래그가 blindField(JSON)와
 * isRegistrationOpen(해시 필드) 두 곳에 나뉘어 있어서다 — 둘의 갱신이 실제로
 * 같은 키에 반영되는지까지 봐야 의미가 있다.
 */
describe('RedisService.checkAndSyncBlindLevel — 등록 마감', () => {
  let redis: Redis;
  let service: RedisService;

  const TOURNAMENT = 'tournament-blind';
  const infoKey = `tournament:${TOURNAMENT}:info`;

  // 레벨당 20분. lv 필드가 곧 마감 기준값(rebuyUntil)과 비교되는 값이다.
  const STRUCTURE = [1, 2, 3, 4, 5].map((lv) => ({
    lv,
    sb: lv * 100,
    ante: false,
    duration: 20,
  }));

  const MINUTE = 60 * 1000;

  /**
   * 시작한 지 elapsedMinutes 지난 토너먼트를 만든다.
   * blindField에는 아직 레벨 0이 저장돼 있고 nextLevelAt은 이미 지난 시각이라,
   * checkAndSyncBlindLevel이 "밀린 레벨"을 따라잡는 경로를 타게 된다.
   */
  const seed = async (elapsedMinutes: number, rebuyUntil: number) => {
    const startedAt = Date.now() - elapsedMinutes * MINUTE;
    await service.setTournamentMeta(
      TOURNAMENT,
      {
        isRegistrationOpen: true,
        totalPlayer: 9,
        activePlayer: 9,
        totalBuyinAmount: 90000,
        rebuyUntil,
        avgStack: 30000,
        tournamentName: '테스트 토너먼트',
        entryFee: 10000,
        startStack: 30000,
        itmCount: 3,
        prizePool: 90000,
        prizes: [
          { place: 1, percent: 50, amount: 45000 },
          { place: 2, percent: 30, amount: 27000 },
          { place: 3, percent: 20, amount: 18000 },
        ],
      },
      {
        isBreak: false,
        startedAt,
        currentBlindLv: 0,
        nextLevelAt: startedAt + 20 * MINUTE,
        serverTime: startedAt,
        blindStructure: STRUCTURE,
      },
    );
  };

  beforeAll(() => {
    redis = createTestRedis();
    service = new RedisService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  it('마감 레벨에 정확히 도달하면 등록을 닫는다', async () => {
    // 30분 경과 = 레벨 인덱스 1 = lv 2. rebuyUntil과 정확히 일치하는 경우.
    await seed(30, 2);

    const blind = await service.checkAndSyncBlindLevel(TOURNAMENT);

    expect(blind?.currentBlindLv).toBe(1);
    expect(await redis.hget(infoKey, 'isRegistrationOpen')).toBe('0');
  });

  it('마감 레벨을 건너뛰어도 등록을 닫는다', async () => {
    // 50분 경과 = 레벨 인덱스 2 = lv 3. 마감 기준 lv 2를 밟지 않고 지나갔다.
    // 정확 일치로 비교하면 여기서 등록이 영영 열린 채로 남아, 이미 끝난
    // 리바인 시간에 참가비를 계속 받게 된다.
    await seed(50, 2);

    const blind = await service.checkAndSyncBlindLevel(TOURNAMENT);

    expect(blind?.currentBlindLv).toBe(2);
    expect(await redis.hget(infoKey, 'isRegistrationOpen')).toBe('0');
  });

  it('마감 레벨 전이면 등록은 열려 있다', async () => {
    // 10분 경과 = 레벨 인덱스 0 = lv 1.
    await seed(10, 3);

    await service.checkAndSyncBlindLevel(TOURNAMENT);

    expect(await redis.hget(infoKey, 'isRegistrationOpen')).toBe('1');
  });
});
