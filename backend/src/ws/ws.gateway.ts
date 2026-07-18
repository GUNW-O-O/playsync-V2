import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { DealerService } from 'src/dealer/dealer.service';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { RedisService } from 'src/redis/redis.service';

@WebSocketGateway({
  path: '/playsync',
  cors: true
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {

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

  // 1. 연결 시 토큰 검증 및 테이블 입장
  async handleConnection(client: WebSocket, request: any) {
    try {
      const url = new URL(request.url, `http://${request.headers['host']}`);
      const tableId = url.searchParams.get('tableId');
      const token = url.searchParams.get('token');
      let tournamentId = url.searchParams.get('tournamentId');

      if (!token) throw new Error('필수 정보 누락');
      // JWT 검증 (딜러 토큰이든 유저 토큰이든 JwtService가 해석)
      const payload = await this.jwtService.verifyAsync(token);
      
      // 소켓 객체에 유저 정보 저장 (나중에 액션 시 사용)
      (client as any).userId = payload.sub;
      (client as any).role = payload.role;
      if (payload.tournamentId) {
        console.log('토큰 검증 토너먼트', payload.tournamentId);
        (client as any).tournamentId = payload.tournamentId;
      }

      // 1. 자리 예매 시 (토너먼트 진입 전)
      if (tournamentId && !tableId) {
        (client as any).tournamentId = tournamentId;
        this.addToMap(this.tournamentSessions, tournamentId, client);
        console.log(`자리예매토너먼트: ${tournamentId}`);
        return; // 예매 로직만 수행하므로 여기서 종료
      }

      // 2. 테이블 진입 시 (게임 시작 후)
      if (tableId) {
        (client as any).tableId = tableId;
        this.addToMap(this.tableSessions, tableId, client);

        const updatedState = await this.redis.getSnapShot(tableId);
        this.broadcastToTable(tableId, 'renderGame', updatedState);
        console.log(`${payload.role} 플레이싱크 참여: ${tableId}`);
        console.log(payload.tournamentId)
      }

    } catch (err) {
      console.error('연결 거부:', err.message);
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
      } else {
        console.log(`User left Table ${tableId}`);
      }
    }
    if (tournamentId && this.tournamentSessions.has(tournamentId)) {
      const sessions = this.tournamentSessions.get(tournamentId);
      sessions?.delete(client);
      if (sessions?.size === 0) {
        this.tournamentSessions.delete(tournamentId);
      } else {
        console.log(`User left Tournament Room ${tournamentId}`);
      }
    }
  }

  // 테이블 브로드캐스트 유틸리티
  private broadcastToTable(tableId: string, event: string, data: any) {
    const sessions = this.tableSessions.get(tableId);
    if (sessions) {
      const message = JSON.stringify({ event, data });
      sessions.forEach(s => s.send(message));
    }
  }
  // 토너먼트 브로드캐스트 유틸리티
  private broadcastToTournament(tournamentId: string, event: string, data: any) {
    const sessions = this.tournamentSessions.get(tournamentId);
    if (sessions) {
      const message = JSON.stringify({ event, data });
      sessions.forEach(s => {
        if (s.readyState === WebSocket.OPEN) {
          s.send(message);
        } else {
          sessions.delete(s);
        }
      });
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

    try {
      const updatedState = await this.playsync.handleAction(userId, tableId, { action: data.action, amount: data.amount });

      // 해당 테이블의 모든 인원에게 변경된 상태 브로드캐스트
      this.broadcastToTable(tableId, 'renderGame', updatedState);
    } catch (e) {
      return { event: 'error', data: e.message };
    }
  }

  @SubscribeMessage('DEALER_ACTION')
  async handleDealerAction(@ConnectedSocket() client: any, @MessageBody() data: any) {
    const { tableId, role, tournamentId } = client;

    if (role !== 'DEALER') return { event: 'error', data: '딜러만 가능한 액션입니다.' };
    let updatedState;

    switch (data.action) {
      case 'START_PRE_FLOP':
        updatedState = await this.dealer.startPreFlop(tournamentId, tableId);
        break;
      case 'RESOLVE_WINNERS':
        updatedState = await this.dealer.resolveWinners(tableId, tournamentId, data.winnerUserIds);
        break;
      case 'DEALER_FOLD':
        updatedState = await this.dealer.handleDealerAction(tournamentId, tableId, data.targetUserId, 'FOLD');
        break;
      case 'DEALER_KICK':
        updatedState = await this.dealer.handleDealerAction(tournamentId, tableId, data.targetUserId, 'KICK');
        break;
    }

    this.broadcastToTable(tableId, 'renderGame', updatedState);
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
  handleRebuyResponse(@ConnectedSocket() client: any, @MessageBody() data: { accept: boolean }) {
    const userId = (client as any).userId;
    this.eventEmitter.emit(`rebuy_res_${userId}`, data.accept);
  }

}
