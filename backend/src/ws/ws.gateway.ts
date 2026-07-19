import { Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Role } from '@prisma/client';
import { DealerAction, DealerActionSchema, PlayerActionSchema, RebuyResponseSchema } from '@playsync/contract';
import { DealerService } from 'src/dealer/dealer.service';
import { TableState } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { RedisService } from 'src/redis/redis.service';

/**
 * 브라우저를 경유한 접속에만 적용된다. 기본값은 개발용 프론트다.
 */
function allowedOrigins(): string[] {
  const configured = process.env.WS_ALLOWED_ORIGINS;
  if (!configured) return ['http://localhost:3000'];
  return configured.split(',').map((o) => o.trim()).filter(Boolean);
}

// 여기에 cors 옵션을 주지 않는다. WsAdapter(네이티브 ws)는 그 옵션을 무시하므로
// 설정해 두면 막고 있다는 착각만 남는다. Origin은 핸드셰이크에서 직접 본다.
@WebSocketGateway({
  path: '/playsync',
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WsGateway.name);

  // 토너먼트 전체 (예매, 공지용)
  private tournamentSessions = new Map<string, Set<WebSocket>>();
  // 개별 테이블 (게임 플레이용)
  private tableSessions = new Map<string, Set<WebSocket>>();
  constructor(
    private readonly dealer: DealerService,
    private readonly playsync: PlaysyncService,
    private readonly redis: RedisService,
    private readonly jwtService: JwtService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  private addToMap(map: Map<string, Set<WebSocket>>, id: string, client: WebSocket) {
    let sessions = map.get(id);
    if (!sessions) {
      sessions = new Set();
      map.set(id, sessions);
    }
    sessions.add(client);
  }

  /**
   * 브라우저는 WebSocket에 same-origin 정책을 강제하지 않는다. 다른 사이트가
   * 피해자의 브라우저를 시켜 이 엔드포인트를 열게 하는 것(CSWSH)을 막으려면
   * 핸드셰이크의 Origin을 서버가 직접 봐야 한다.
   *
   * Origin이 아예 없으면 통과시킨다 — 좌석 태블릿처럼 브라우저가 아닌
   * 클라이언트는 이 헤더를 보내지 않는다. 즉 이 검사는 브라우저를 경유한
   * 접속만 막는다. 그 외의 접근을 막는 것은 토큰과 아래의 소속 검증이다.
   */
  private assertAllowedOrigin(origin?: string) {
    if (!origin) return;
    if (!allowedOrigins().includes(origin)) {
      throw new Error(`허용되지 않은 출처입니다: ${origin}`);
    }
  }

  /**
   * 이 접속이 이 테이블을 볼 자격이 있는지 확인한다.
   *
   * 어느 쪽도 클라이언트가 보낸 값을 근거로 삼지 않는다. 딜러는 로그인 시
   * 서명된 토큰의 tableId를, 플레이어는 서버가 들고 있는 스냅샷의 좌석을 본다.
   */
  private async assertTableAccess(payload: any, tableId: string) {
    if (payload.role === Role.DEALER) {
      // 토큰의 tableId는 loginDealer가 서명해 넣은 값이고, 쿼리의 tableId는
      // 클라이언트가 고른 값이다. 대조하지 않으면 A테이블 딜러가 B테이블의
      // 핸드 시작·킥·승자 지정 권한을 그대로 얻는다. 승자는 계산되는 값이
      // 아니라 딜러가 입력하는 값이라 사후에 검증할 정답도 없다.
      if (payload.tableId !== tableId) {
        throw new Error('토큰에 없는 테이블입니다.');
      }
      return;
    }

    const state = await this.redis.getSnapShot(tableId);
    if (!state) throw new Error('테이블을 찾을 수 없습니다.');

    const isSeated = state.players.some((p) => p?.id === payload.sub);
    if (!isSeated) throw new Error('이 테이블의 좌석이 없습니다.');
  }

  // 1. 연결 시 토큰 검증 및 테이블 입장
  async handleConnection(client: WebSocket, request: any) {
    try {
      const url = new URL(request.url, `http://${request.headers['host']}`);
      const tableId = url.searchParams.get('tableId');
      const token = url.searchParams.get('token');
      const tournamentId = url.searchParams.get('tournamentId');

      this.assertAllowedOrigin(request.headers['origin']);

      if (!token) throw new Error('필수 정보 누락');
      // JWT 검증 (딜러 토큰이든 유저 토큰이든 JwtService가 해석)
      const payload = await this.jwtService.verifyAsync(token);

      // 소켓 객체에 유저 정보 저장 (나중에 액션 시 사용)
      (client as any).userId = payload.sub;
      (client as any).role = payload.role;
      if (payload.tournamentId) {
        (client as any).tournamentId = payload.tournamentId;
      }

      // 1. 자리 예매 시 (토너먼트 진입 전)
      if (tournamentId && !tableId) {
        (client as any).tournamentId = tournamentId;
        this.addToMap(this.tournamentSessions, tournamentId, client);
        return; // 예매 로직만 수행하므로 여기서 종료
      }

      // 2. 테이블 진입 시 (게임 시작 후)
      if (tableId) {
        await this.assertTableAccess(payload, tableId);

        (client as any).tableId = tableId;
        this.addToMap(this.tableSessions, tableId, client);

        // 접속자 본인에게만 보낸다. 남이 접속했다고 테이블 전원이 같은 상태를
        // 다시 받을 이유가 없다.
        const state = await this.redis.getSnapShot(tableId);
        client.send(JSON.stringify({ event: 'renderGame', data: state }));
      }

    } catch (err) {
      // 거부된 접속은 보안 신호다. 잘못된 토큰과 허용되지 않은 출처가
      // 여기로 모인다.
      this.logger.warn(`연결 거부: ${err.message}`);
      client.close(1008, '인증 실패');
    }
  }

  // 2. 연결 종료 시 세션 제거
  handleDisconnect(client: WebSocket) {
    const tableId = (client as any).tableId;
    const tournamentId = (client as any).tournamentId;

    // 테이블 세션 제거
    if (tableId && this.tableSessions.has(tableId)) {
      const sessions = this.tableSessions.get(tableId);
      sessions?.delete(client);
      if (sessions?.size === 0) {
        this.tableSessions.delete(tableId);
      }
    }
    if (tournamentId && this.tournamentSessions.has(tournamentId)) {
      const sessions = this.tournamentSessions.get(tournamentId);
      sessions?.delete(client);
      if (sessions?.size === 0) {
        this.tournamentSessions.delete(tournamentId);
      }
    }
  }

  /**
   * 살아 있는 소켓에만 보내고, 죽은 소켓은 그 자리에서 정리한다.
   *
   * 닫힌 소켓에 `send`하면 `ws`가 던진다. 루프 안에서 던지면 루프가 통째로
   * 중단되어, 뒤에 있는 멀쩡한 클라이언트들이 상태를 못 받는다. 죽은 소켓 하나가
   * 테이블 전체를 멈추는 셈이라 걸러내는 것이 선택이 아니다.
   *
   * 개별 `send` 실패도 삼킨다. 보내는 도중 끊긴 소켓 때문에 나머지가 피해를
   * 보면 안 된다 — 어차피 그 소켓은 곧 `handleDisconnect`로 정리된다.
   */
  private broadcast(sessions: Set<WebSocket> | undefined, event: string, data: any) {
    if (!sessions) return;
    const message = JSON.stringify({ event, data });
    sessions.forEach(s => {
      if (s.readyState !== WebSocket.OPEN) {
        sessions.delete(s);
        return;
      }
      try {
        s.send(message);
      } catch (e) {
        sessions.delete(s);
      }
    });
  }

  // 테이블 브로드캐스트 유틸리티
  private broadcastToTable(tableId: string, event: string, data: any) {
    this.broadcast(this.tableSessions.get(tableId), event, data);
    if (this.tableSessions.get(tableId)?.size === 0) {
      this.tableSessions.delete(tableId);
    }
  }
  // 토너먼트 브로드캐스트 유틸리티
  private broadcastToTournament(tournamentId: string, event: string, data: any) {
    this.broadcast(this.tournamentSessions.get(tournamentId), event, data);
    if (this.tournamentSessions.get(tournamentId)?.size === 0) {
      this.tournamentSessions.delete(tournamentId);
    }
  }
  // 유저 브로드캐스트 유틸리티
  private sendToTableUser(tableId: string, userId: string, event: string, data: any) {
    const sessions = this.tableSessions.get(tableId);
    if (sessions) {
      // 해당 테이블에 접속한 소켓들 중 userId가 일치하는 소켓 검색
      for (const socket of sessions) {
        if ((socket as any).userId === userId) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ event, data }));
          }
          break; // 찾았으면 루프 종료
        }
      }
    }
  }

  @SubscribeMessage('PLAYER_ACTION')
  async handlePlayerAction(@ConnectedSocket() client: any, @MessageBody() data: any) {
    const { tableId, userId, role } = client;

    // 딜러 토큰의 sub는 딜러 세션 id라 좌석과 매칭되지 않는다. 서비스가
    // 걸러내기는 하지만, 권한 판단은 경계에서 명시적으로 하는 편이 읽기 쉽다.
    if (role === Role.DEALER) {
      return { event: 'error', data: '플레이어만 가능한 액션입니다.' };
    }

    // 스키마가 곧 화이트리스트다. TIME_OUT처럼 서버 내부에서만 만들어지는
    // 액션은 애초에 스키마에 없으므로 여기서 걸린다.
    const parsed = PlayerActionSchema.safeParse(data);
    if (!parsed.success) {
      return { event: 'error', data: '잘못된 액션입니다.' };
    }

    try {
      const updatedState = await this.playsync.handleAction(userId, tableId, parsed.data);

      // 해당 테이블의 모든 인원에게 변경된 상태 브로드캐스트
      this.broadcastToTable(tableId, 'renderGame', updatedState);
    } catch (e) {
      return { event: 'error', data: e.message };
    }
  }

  @SubscribeMessage('DEALER_ACTION')
  async handleDealerAction(@ConnectedSocket() client: any, @MessageBody() data: any) {
    const { tableId, role, tournamentId } = client;

    if (role !== Role.DEALER) return { event: 'error', data: '딜러만 가능한 액션입니다.' };

    const parsed = DealerActionSchema.safeParse(data);
    if (!parsed.success) {
      return { event: 'error', data: '잘못된 딜러 명령입니다.' };
    }
    const action = parsed.data;

    try {
      const updatedState = await this.runDealerAction(tournamentId, tableId, action);
      this.broadcastToTable(tableId, 'renderGame', updatedState);
    } catch (e) {
      return { event: 'error', data: e.message };
    }
  }

  /**
   * 딜러 명령 하나를 실행하고 **반드시 상태를 돌려준다.**
   *
   * 반환 타입에 `undefined`가 없는 것이 이 함수의 요점이다. 예전에는 실패를
   * 조용한 `return;`으로 표현했고, 그 undefined가 `renderGame`으로 브로드캐스트되어
   * 테이블 전원의 게임 상태를 덮었다. 실패는 예외로만 표현하면 "브로드캐스트할
   * 상태가 없는데 브로드캐스트하는" 경로가 아예 만들어지지 않는다.
   */
  private async runDealerAction(
    tournamentId: string,
    tableId: string,
    action: DealerAction,
  ): Promise<TableState> {
    switch (action.action) {
      case 'START_PRE_FLOP':
        return this.dealer.startPreFlop(tournamentId, tableId);
      case 'RESOLVE_WINNERS':
        return this.dealer.resolveWinners(tableId, tournamentId, action.winnerUserIds);
      case 'DEALER_FOLD':
        return this.dealer.handleDealerAction(tournamentId, tableId, action.targetUserId, 'FOLD');
      case 'DEALER_KICK':
        return this.dealer.handleDealerAction(tournamentId, tableId, action.targetUserId, 'KICK');
      case 'RETRY_CHECKPOINT':
        return this.dealer.retryCheckpoint(tableId);
      default: {
        // 스키마가 이미 모르는 액션을 거르므로 런타임에 여기 오지 않는다.
        // 이 줄의 목적은 컴파일 타임이다 — contract에 액션을 추가하면 case를
        // 채울 때까지 타입 에러가 난다. 문자열 default는 그 실수를 못 잡는다.
        const unreachable: never = action;
        throw new Error(`알 수 없는 딜러 액션: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // 타임아웃 프로세서
  @OnEvent('game.state.updated')
  handleGameStateUpdated(payload: { tableId: string; state: any }) {
    this.broadcastToTable(payload.tableId, 'renderGame', payload.state);
  }

  @OnEvent('SEAT_LIST_UPDATED')
  handleSeatListUpdated(payload: { tournamentId: string; state: any }) {
    this.broadcastToTournament(payload.tournamentId, 'renderSeatList', payload.state);
  }

  @OnEvent('rebuy.request.sent')
  handleRebuyRequest(payload: { userId: string, tableId: string, deadline: number, userPoints: any, entryFee: number, tournamentName: string }) {
    this.sendToTableUser(payload.tableId, payload.userId, 'REBUY_PROMPT', {
      deadline: payload.deadline,
      userPoints: payload.userPoints,
      entryFee: payload.entryFee,
      tournamentName: payload.tournamentName,
    });
  }

  @SubscribeMessage('REBUY_RESPONSE')
  handleRebuyResponse(@ConnectedSocket() client: any, @MessageBody() data: any) {
    const parsed = RebuyResponseSchema.safeParse(data);
    // accept가 없으면 undefined가 그대로 흘러가 거절로 취급된다.
    // 거절과 잘못된 요청은 구분되어야 한다.
    if (!parsed.success) {
      return { event: 'error', data: '잘못된 리바인 응답입니다.' };
    }

    const userId = (client as any).userId;
    this.eventEmitter.emit(`rebuy_res_${userId}`, parsed.data.accept);
  }

}
