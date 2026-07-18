import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { WsGateway } from './ws.gateway';
import { RedisService } from 'src/redis/redis.service';
import { DealerService } from 'src/dealer/dealer.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { GamePhase, TablePlayer, TableState } from 'src/game-engine/types';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';

/**
 * 게이트웨이의 인바운드 경계.
 *
 * 여기가 유일하게 외부 입력이 들어오는 지점이다. 플레이어 단말은 좌석에 고정된
 * 태블릿이고 버튼과 슬라이더만 조작할 수 있지만, 그것은 UI의 제약이지 서버의
 * 제약이 아니다 — 망이 행사장 WiFi라 같은 망의 아무 단말이나 이 엔드포인트를
 * 직접 열 수 있다.
 */
describe('WsGateway 인바운드 경계', () => {
  let redis: Redis;
  let gateway: WsGateway;
  let jwt: JwtService;
  let playsync: { handleAction: jest.Mock };
  let dealer: {
    startPreFlop: jest.Mock;
    resolveWinners: jest.Mock;
    handleDealerAction: jest.Mock;
  };

  const TABLE = 'table-1';
  const OTHER_TABLE = 'table-2';
  const TOURNAMENT = 'tournament-1';
  const SECRET = 'test-only-not-a-real-secret';

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

  function makeState(): TableState {
    return {
      phase: GamePhase.PRE_FLOP,
      players: [makePlayer('alice', 0), makePlayer('bob', 1)],
      buttonUser: 0,
      currentTurnSeatIndex: 0,
      pot: 0,
      sidePots: [],
      currentBet: 100,
      smallBlind: 50,
      ante: false,
      tournamentId: TOURNAMENT,
    };
  }

  /**
   * 최소한의 가짜 소켓. 거부는 close(1008)로 관찰한다.
   *
   * 닫힌 소켓에 send하면 던진다 — `ws`가 실제로 그렇게 동작한다. 브로드캐스트가
   * 이걸 걸러내지 않으면 죽은 소켓 하나가 루프를 중단시켜 뒤에 있는 멀쩡한
   * 클라이언트들이 상태를 못 받는다.
   */
  function makeClient(readyState = 1) {
    const client: any = {
      close: jest.fn(),
      send: jest.fn(() => {
        if (client.readyState !== 1) throw new Error('WebSocket is not open');
      }),
      readyState,
    };
    return client;
  }

  function makeRequest(query: string, origin?: string) {
    return {
      url: `/playsync?${query}`,
      headers: origin ? { host: 'localhost', origin } : { host: 'localhost' },
    };
  }

  function playerToken(userId: string) {
    return jwt.sign({ sub: userId, nickname: userId, role: 'USER' });
  }

  function dealerToken(tableId: string) {
    return jwt.sign({
      sub: 'dealer-session-1',
      tournamentId: TOURNAMENT,
      tableId,
      role: 'DEALER',
    });
  }

  /** 접속에 성공해 테이블에 붙은 소켓을 돌려준다. */
  async function connect(token: string, tableId = TABLE, origin = 'http://localhost:3000') {
    const client = makeClient();
    await gateway.handleConnection(client, makeRequest(`tableId=${tableId}&token=${token}`, origin));
    return client;
  }

  beforeAll(() => {
    redis = createTestRedis();
    jwt = new JwtService({ secret: SECRET });
    playsync = { handleAction: jest.fn().mockResolvedValue(makeState()) };
    dealer = {
      startPreFlop: jest.fn().mockResolvedValue(makeState()),
      resolveWinners: jest.fn().mockResolvedValue(makeState()),
      handleDealerAction: jest.fn().mockResolvedValue(makeState()),
    };

    gateway = new WsGateway(
      dealer as unknown as DealerService,
      playsync as unknown as PlaysyncService,
      new RedisService(redis),
      jwt,
      new EventEmitter2(),
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
    await redis.set(`table:state:${TABLE}`, JSON.stringify(makeState()));
    await redis.set(`table:state:${OTHER_TABLE}`, JSON.stringify(makeState()));
    jest.clearAllMocks();
  });

  describe('접속 — 딜러 토큰', () => {
    it('토큰에 적힌 테이블에는 붙는다', async () => {
      const client = await connect(dealerToken(TABLE));
      expect(client.close).not.toHaveBeenCalled();
    });

    it('다른 테이블에는 붙을 수 없다', async () => {
      // 토큰의 tableId는 loginDealer가 서명해 넣은 값이고, 접속 쿼리의
      // tableId는 클라이언트가 고른 값이다. 대조하지 않으면 A테이블 딜러가
      // B테이블의 핸드 시작·킥·승자 지정 권한을 그대로 얻는다.
      const client = await connect(dealerToken(TABLE), OTHER_TABLE);
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('접속 — 플레이어 토큰', () => {
    it('자기 좌석이 있는 테이블에는 붙는다', async () => {
      const client = await connect(playerToken('alice'));
      expect(client.close).not.toHaveBeenCalled();
    });

    it('좌석이 없는 테이블에는 붙을 수 없다', async () => {
      // 인증만 되면 아무 tableId로나 붙어 renderGame을 전부 수신할 수 있었다.
      // 카드는 실물이라 홀카드는 새지 않지만 스택·팟·베팅·턴이 전부 나간다.
      await redis.set(
        `table:state:${OTHER_TABLE}`,
        JSON.stringify({ ...makeState(), players: [makePlayer('carol', 0)] }),
      );

      const client = await connect(playerToken('alice'), OTHER_TABLE);
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('존재하지 않는 테이블에는 붙을 수 없다', async () => {
      const client = await connect(playerToken('alice'), 'no-such-table');
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });
  });

  describe('접속 — 토큰과 Origin', () => {
    it('토큰이 없으면 거부한다', async () => {
      const client = makeClient();
      await gateway.handleConnection(client, makeRequest(`tableId=${TABLE}`));
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('위조된 토큰을 거부한다', async () => {
      const forged = new JwtService({ secret: 'wrong-secret' }).sign({
        sub: 'alice',
        role: 'USER',
      });
      const client = await connect(forged);
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('허용 목록에 없는 Origin을 거부한다', async () => {
      // 브라우저는 WebSocket에 same-origin을 강제하지 않는다. 다른 사이트가
      // 피해자 브라우저를 시켜 이 엔드포인트를 열게 하는 것을 막으려면
      // 핸드셰이크의 Origin을 직접 봐야 한다.
      const client = await connect(playerToken('alice'), TABLE, 'http://evil.example');
      expect(client.close).toHaveBeenCalledWith(1008, expect.any(String));
    });

    it('Origin이 없는 접속은 허용한다', async () => {
      // 태블릿 앱처럼 브라우저가 아닌 클라이언트는 Origin을 보내지 않는다.
      // Origin 검증이 막는 것은 브라우저를 경유한 요청뿐이다.
      const client = makeClient();
      await gateway.handleConnection(
        client,
        makeRequest(`tableId=${TABLE}&token=${playerToken('alice')}`),
      );
      expect(client.close).not.toHaveBeenCalled();
    });
  });

  describe('PLAYER_ACTION', () => {
    it('유효한 액션은 통과시킨다', async () => {
      const client = await connect(playerToken('alice'));

      await gateway.handlePlayerAction(client, { action: 'FOLD' });

      expect(playsync.handleAction).toHaveBeenCalledWith('alice', TABLE, { action: 'FOLD' });
    });

    it.each(['TIME_OUT', 'DEALER_KICK', 'DEALER_FOLD'])(
      '내부 전용 액션 %s를 거부한다',
      async (action) => {
        const client = await connect(playerToken('alice'));

        const result = await gateway.handlePlayerAction(client, { action });

        expect(playsync.handleAction).not.toHaveBeenCalled();
        expect(result?.event).toBe('error');
      },
    );

    it('서버가 읽지 않는 키가 섞이면 거부한다', async () => {
      // 프론트는 매 액션마다 token과 tableId를 실어 보냈지만 서버는 둘 다
      // 읽지 않는다 — 핸드셰이크에서 이미 검증했다.
      const client = await connect(playerToken('alice'));

      const result = await gateway.handlePlayerAction(client, {
        action: 'FOLD',
        token: 'ey...',
        tableId: TABLE,
      });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('금액 없는 RAISE를 거부한다', async () => {
      const client = await connect(playerToken('alice'));

      const result = await gateway.handlePlayerAction(client, { action: 'RAISE' });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('딜러 토큰으로는 플레이어 액션을 보낼 수 없다', async () => {
      const client = await connect(dealerToken(TABLE));

      const result = await gateway.handlePlayerAction(client, { action: 'FOLD' });

      expect(playsync.handleAction).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });
  });

  describe('DEALER_ACTION', () => {
    it('유효한 명령은 통과시킨다', async () => {
      const client = await connect(dealerToken(TABLE));

      await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(dealer.startPreFlop).toHaveBeenCalledWith(TOURNAMENT, TABLE);
    });

    it('플레이어 토큰으로는 보낼 수 없다', async () => {
      const client = await connect(playerToken('alice'));

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(dealer.startPreFlop).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('모르는 명령에 undefined를 브로드캐스트하지 않는다', async () => {
      // switch에 default가 없어서, 걸리지 않는 액션이 오면 updatedState가
      // undefined인 채로 테이블 전원에게 전송됐다.
      const client = await connect(dealerToken(TABLE));
      client.send.mockClear();

      const result = await gateway.handleDealerAction(client, { action: 'DROP_TABLE' });

      expect(result?.event).toBe('error');
      expect(client.send).not.toHaveBeenCalled();
    });

    it('빈 승자 목록을 거부한다', async () => {
      const client = await connect(dealerToken(TABLE));

      const result = await gateway.handleDealerAction(client, {
        action: 'RESOLVE_WINNERS',
        winnerUserIds: [],
      });

      expect(dealer.resolveWinners).not.toHaveBeenCalled();
      expect(result?.event).toBe('error');
    });

    it('서비스가 던진 에러를 잡아서 돌려준다', async () => {
      // 여기엔 try/catch가 없어서 휴식 중 START_PRE_FLOP 같은 정상적인 거절이
      // 처리되지 않은 rejection으로 새어 나갔다.
      const client = await connect(dealerToken(TABLE));
      dealer.startPreFlop.mockRejectedValueOnce(new Error('휴식 상태입니다.'));

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '휴식 상태입니다.' });
    });

    it('시작할 수 없는 상태는 에러로 돌아온다', async () => {
      // 예전에는 startPreFlop이 undefined를 반환했고 게이트웨이가 `if (updatedState)`로
      // 그걸 걸렀다. 지금은 실패가 예외로만 표현되므로 "상태 없이 성공한" 반환값
      // 자체가 존재하지 않는다 — 걸러낼 것이 없어졌다.
      const client = await connect(dealerToken(TABLE));
      dealer.startPreFlop.mockRejectedValueOnce(new Error('대기 상태가 아닙니다.'));
      client.send.mockClear();

      const result = await gateway.handleDealerAction(client, { action: 'START_PRE_FLOP' });

      expect(result).toEqual({ event: 'error', data: '대기 상태가 아닙니다.' });
      expect(client.send).not.toHaveBeenCalled();
    });
  });
  describe('딜러 명령 실패', () => {
    it('실패하면 아무에게도 브로드캐스트하지 않는다', async () => {
      // 조용한 return이 undefined를 만들어 renderGame으로 흘러가면, 테이블
      // 전원의 게임 상태가 undefined로 덮인다. 딜러의 실수 한 번에 전 화면이
      // 날아가는 셈이다.
      const dealerClient = await connect(dealerToken(TABLE));
      const player = await connect(playerToken('alice'));
      dealer.startPreFlop.mockRejectedValue(new Error('대기 상태가 아닙니다.'));
      jest.clearAllMocks();

      const res = await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(res).toEqual({ event: 'error', data: '대기 상태가 아닙니다.' });
      expect(player.send).not.toHaveBeenCalled();
    });

    it('성공하면 테이블 전원에게 브로드캐스트한다', async () => {
      const dealerClient = await connect(dealerToken(TABLE));
      const player = await connect(playerToken('alice'));
      dealer.startPreFlop.mockResolvedValue(makeState());
      jest.clearAllMocks();

      await gateway.handleDealerAction(dealerClient, { action: 'START_PRE_FLOP' });

      expect(player.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(player.send.mock.calls[0][0]);
      expect(sent.event).toBe('renderGame');
      expect(sent.data).not.toBeUndefined();
    });
  });

  describe('브로드캐스트 위생', () => {
    it('닫힌 소켓에는 보내지 않는다', async () => {
      const open = await connect(playerToken('alice'));
      const closed = await connect(playerToken('bob'));
      closed.readyState = 3;
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(open.send).toHaveBeenCalledTimes(1);
      expect(closed.send).not.toHaveBeenCalled();
    });

    it('앞선 소켓이 닫혀 있어도 뒤 소켓은 상태를 받는다', async () => {
      // 죽은 소켓에 send하면 ws가 던진다. forEach 안에서 던지면 루프가
      // 통째로 중단되어, 뒤에 있는 멀쩡한 클라이언트들이 상태를 못 받는다.
      const closed = await connect(playerToken('alice'));
      const open = await connect(playerToken('bob'));
      closed.readyState = 3;
      jest.clearAllMocks();

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(open.send).toHaveBeenCalledTimes(1);
    });

    it('닫힌 소켓은 세션에서 정리된다', async () => {
      const closed = await connect(playerToken('alice'));
      await connect(playerToken('bob'));
      closed.readyState = 3;

      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      // 정리됐다면 다시 열려도 이 테이블 브로드캐스트를 받지 않는다.
      closed.readyState = 1;
      jest.clearAllMocks();
      gateway.handleGameStateUpdated({ tableId: TABLE, state: makeState() });

      expect(closed.send).not.toHaveBeenCalled();
    });
  });
});
