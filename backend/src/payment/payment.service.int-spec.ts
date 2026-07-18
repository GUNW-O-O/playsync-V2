import { EventEmitter2 } from '@nestjs/event-emitter';
import { TournamentStatus } from '@prisma/client';
import Redis from 'ioredis';
import { PayMentDto } from 'shared/dto/payment.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionService } from 'src/store/session/session.service';
import { TableState } from 'src/game-engine/types';
import { UserService } from 'src/user/user.service';
import { PaymentService } from './payment.service';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 착석이 DB와 Redis 두 곳에 어떻게 반영되는가.
 *
 * DB는 진짜가 아니라 스텁이다. 검증 대상이 "DB 작업이 실패했을 때 Redis에
 * 무엇이 남는가"이므로 필요한 것은 **실패를 마음대로 일으킬 수 있는 DB**와
 * **진짜 Redis**다. Prisma를 진짜로 띄우면 원하는 지점에서 롤백을 만들기 위해
 * 오히려 더 많은 장치가 필요해진다.
 */
describe('PaymentService.joinSessionWithSeat', () => {
  let redis: Redis;
  let redisService: RedisService;
  let emitter: EventEmitter2;

  const TOURNAMENT = 'tournament-1';
  const TABLE = 'table-1';
  const stateKey = `table:state:${TABLE}`;
  const seatKey = `tournament:${TOURNAMENT}:seat`;

  const sessionRow: {
    id: string;
    name: string;
    status: TournamentStatus;
    isRegistrationOpen: boolean;
    entryFee: number;
    startStack: number;
  } = {
    id: TOURNAMENT,
    name: 'T',
    status: TournamentStatus.PENDING,
    isRegistrationOpen: true,
    entryFee: 1000,
    startStack: 10000,
  };

  function dto(seatIndex: number): PayMentDto {
    return { tournamentId: TOURNAMENT, tableId: TABLE, seatIndex };
  }

  /**
   * @param failAt 어디서 터뜨릴지. undefined면 전부 성공.
   *
   *   - `'write'`: 트랜잭션 중간의 DB 쓰기가 실패한다.
   *   - `'commit'`: 콜백은 끝까지 돌고 **커밋이** 실패한다. P2-1이 노출되는
   *     지점이 여기다. 예전 코드는 `saveSnapShot`을 콜백의 마지막 문장으로
   *     두었으므로 중간 실패로는 Redis에 아무것도 남지 않는다. 반면 커밋
   *     실패는 콜백이 이미 전부 실행된 뒤라, 그때 쓴 스냅샷만 롤백되지 않고
   *     살아남는다 — DB에 없는 사람이 자리를 차지한다.
   */
  function makeService(failAt?: 'write' | 'commit') {
    const tx = {
      tablePlayer: {
        findUnique: async () => null,
        create: async () => ({}),
      },
      tournamentParticipation: { create: async () => ({}) },
      tournament: {
        update: async () => {
          if (failAt === 'write') throw new Error('DB 실패');
          return {};
        },
      },
    };

    const prisma = {
      tournament: { findUnique: async () => sessionRow },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        const result = await fn(tx);
        if (failAt === 'commit') throw new Error('커밋 실패');
        return result;
      },
    } as unknown as PrismaService;

    const user = {
      findByUUID: async (id: string) => ({ id, nickname: id, points: 100000 }),
      paymentPoint: async () => ({}),
    } as unknown as UserService;

    const session = { createTable: async () => ({}) } as unknown as SessionService;

    return new PaymentService(user, session, prisma, redisService, emitter);
  }

  beforeAll(() => {
    redis = createTestRedis();
    redisService = new RedisService(redis);
    emitter = new EventEmitter2();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redisService.setSeatBitmap(TOURNAMENT, TABLE);
  });

  describe('DB 실패', () => {
    it('커밋이 실패하면 스냅샷에 유령 착석이 남지 않는다', async () => {
      // Redis는 Prisma 트랜잭션에 참여하지 않는다. 콜백 안에서 saveSnapShot을
      // 부르면, 커밋이 실패해 DB가 전부 되돌아가도 스냅샷에는 유저가 그대로
      // 앉아 있다 — DB에 없는 사람이 자리를 차지한다.
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow('커밋 실패');

      expect(await redis.get(stateKey)).toBeNull();
    });

    it('중간 쓰기가 실패해도 스냅샷은 비어 있다', async () => {
      const service = makeService('write');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow('DB 실패');

      expect(await redis.get(stateKey)).toBeNull();
    });

    it('롤백되면 좌석 비트맵도 그대로다', async () => {
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow();

      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('000000000');
    });

    it('실패해도 좌석 락은 풀린다', async () => {
      const service = makeService('commit');

      await expect(service.joinSessionWithSeat(dto(3), 'alice')).rejects.toThrow();

      expect(await redis.exists(`lock:seat:${TABLE}:3`)).toBe(0);
    });
  });

  describe('성공', () => {
    it('스냅샷과 비트맵에 함께 반영된다', async () => {
      const service = makeService();

      await service.joinSessionWithSeat(dto(3), 'alice');

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[3]!.id).toBe('alice');
      expect(state.players[3]!.stack).toBe(10000);
      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('000100000');
    });

    it('진행 중인 토너먼트에 앉으면 이번 핸드는 폴드 상태로 들어간다', async () => {
      // 카드는 이미 딜링됐다. 중간에 앉은 사람은 다음 핸드부터 참여한다.
      const service = makeService();
      sessionRow.status = TournamentStatus.ONGOING;

      await service.joinSessionWithSeat(dto(2), 'bob');
      sessionRow.status = TournamentStatus.PENDING;

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[2]!.hasFolded).toBe(true);
    });
  });

  describe('동시 착석', () => {
    it('같은 테이블 다른 좌석에 동시에 앉아도 서로를 지우지 않는다', async () => {
      // 좌석 락은 좌석**별**이라 이 둘은 서로를 막지 않는다. 스냅샷은 JSON을
      // 통째로 덮어쓰므로, 테이블 락이 없으면 나중에 쓴 쪽이 앞선 착석을
      // 통째로 지운다. 결제는 됐는데 자리에 없는 유저가 생긴다.
      const service = makeService();

      await Promise.all([
        service.joinSessionWithSeat(dto(0), 'alice'),
        service.joinSessionWithSeat(dto(5), 'bob'),
      ]);

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players[0]?.id).toBe('alice');
      expect(state.players[5]?.id).toBe('bob');
    });

    it('아홉 명이 동시에 앉아도 전원이 남는다', async () => {
      const service = makeService();
      const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8];

      await Promise.all(seats.map(s => service.joinSessionWithSeat(dto(s), `p${s}`)));

      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players.map(p => p?.id ?? null)).toEqual(seats.map(s => `p${s}`));
      expect(await redis.hget(seatKey, `table:${TABLE}`)).toBe('111111111');
    });

    it('같은 좌석을 동시에 노리면 한 명만 앉는다', async () => {
      const service = makeService();

      const results = await Promise.allSettled([
        service.joinSessionWithSeat(dto(4), 'alice'),
        service.joinSessionWithSeat(dto(4), 'bob'),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const state: TableState = JSON.parse((await redis.get(stateKey))!);
      expect(state.players.filter(p => p !== null)).toHaveLength(1);
    });
  });
});
