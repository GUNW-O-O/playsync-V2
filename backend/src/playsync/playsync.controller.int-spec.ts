import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Role } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { PlaysyncController } from './playsync.controller';
import { PlaysyncService } from './playsync.service';

/**
 * `GET /playsync/:id`(`joinTable`)가 WS와 같은 문을 쓰는지 본다.
 *
 * 예전에는 `JwtAuthGuard`만 걸려 있었다 — 인증만 되면 좌석·소유권·대회
 * 소속을 아무것도 대조하지 않고 `getSnapShot`이 주는 전체 스냅샷(각 플레이어의
 * `id`·`nickname`·`stack`·`bet`)을 그대로 돌려줬다(T66). WS는 같은 자원에
 * `assertTableAccess`를 걸어 왔는데(`ws.gateway.int-spec.ts`가 그 판정 로직
 * 자체를 검증한다), REST 쪽 문만 잠겨 있지 않았다.
 *
 * 여기서 보는 것은 판정 로직의 재검증이 아니라 **배선**이다 — 컨트롤러가
 * `req.user`(역할마다 모양이 다르다: 딜러는 `id`, 그 외는 `userId`)를
 * `PlaysyncService.assertTableAccess`가 요구하는 신원으로 제대로 옮겨
 * 넘기는가, 그리고 실패하면 `joinTable`을 아예 부르지 않는가.
 */
describe('PlaysyncController.joinTable — REST도 WS와 같은 문을 쓴다', () => {
  let redis: Redis;
  let controller: PlaysyncController;

  const TABLE = 'ctrl-table-1';
  const OTHER_TABLE = 'ctrl-table-2';
  const TOURNAMENT = 'ctrl-tournament-1';

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
      ante: false,
      tournamentId: TOURNAMENT,
    };
  }

  beforeAll(() => {
    redis = createTestRedis();
    const service = new PlaysyncService(
      {} as unknown as Queue,
      new RedisService(redis),
      {} as unknown as PrismaService,
      new EventEmitter2(),
    );
    controller = new PlaysyncController(service);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState(['alice'])));
  });

  it('그 테이블에 앉지 않은 유저는 거부된다 — 예전에는 이 요청이 스냅샷을 그대로 돌려줬다', async () => {
    const req = { user: { userId: 'mallory', role: Role.USER } };

    await expect(controller.joinTable(TABLE, req)).rejects.toThrow(ForbiddenException);
  });

  it('앉은 좌석의 테이블은 스냅샷과 seatIndex를 받는다', async () => {
    const req = { user: { userId: 'alice', role: SEAT_ROLE, tableId: TABLE } };

    const result = await controller.joinTable(TABLE, req);

    expect(result.seatIndex).toBe(0);
    expect(result.tableState.players[0]?.id).toBe('alice');
  });

  it('자기 좌석이 있어도 남의 테이블은 거부된다', async () => {
    await redis.set(`table:state:${OTHER_TABLE}`, JSON.stringify(makeState(['bob'])));
    const req = { user: { userId: 'alice', role: SEAT_ROLE, tableId: TABLE } };

    // 토큰에 실린 tableId가 아니라, 요청 URL이 가리키는 테이블에 실제로
    // 앉아 있는지를 본다 — WS의 플레이어 판정과 같은 근거다.
    await expect(controller.joinTable(OTHER_TABLE, req)).rejects.toThrow(ForbiddenException);
  });

  it('딜러는 토큰에 서명된 테이블이면 좌석 없이도(-1) 받는다', async () => {
    const req = {
      user: { id: 'dealer-session-1', role: Role.DEALER, tableId: TABLE, tournamentId: TOURNAMENT },
    };

    const result = await controller.joinTable(TABLE, req);

    expect(result.seatIndex).toBe(-1);
    expect(result.tableState.players.map((p) => p?.id)).toEqual(['alice']);
  });

  it('딜러가 토큰에 없는 테이블을 요청하면 거부된다 — A테이블 딜러가 B테이블을 열 수 없다', async () => {
    await redis.set(`table:state:${OTHER_TABLE}`, JSON.stringify(makeState(['bob'])));
    const req = {
      user: { id: 'dealer-session-1', role: Role.DEALER, tableId: TABLE, tournamentId: TOURNAMENT },
    };

    await expect(controller.joinTable(OTHER_TABLE, req)).rejects.toThrow(ForbiddenException);
  });

  it('스냅샷이 없는 테이블은 404다 — 존재 여부까지는 감추지 않는다', async () => {
    const req = { user: { userId: 'alice', role: SEAT_ROLE, tableId: 'no-such-table' } };

    await expect(controller.joinTable('no-such-table', req)).rejects.toThrow(NotFoundException);
  });
});
