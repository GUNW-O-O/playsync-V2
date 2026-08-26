import { Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Role } from '@prisma/client';
import {
  DealerAction,
  DealerActionSchema,
  PlayerActionSchema,
  RebuyResponseSchema,
  TableStateSchema,
  TableState as WireTableState,
  TournamentClosedSchema,
} from '@playsync/contract';
import { DealerService } from 'src/dealer/dealer.service';
import { TableState } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { WsIdentity, WsTicketService } from './ws-ticket.service';

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
    private readonly tickets: WsTicketService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
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
   * **헤더가 없으면 거부한다.** 예전에는 통과시켰고, 근거는 "좌석 태블릿처럼
   * 브라우저가 아닌 클라이언트는 이 헤더를 보내지 않는다"였다. 실제로는 좌석·딜러
   * 태블릿 모두 Next 화면이라 전부 브라우저다 — 헤더를 빼는 것은 브라우저를
   * 경유하지 않는 접속뿐이고, 그것이 이 검사가 막으려던 바로 그 대상이다.
   */
  private assertAllowedOrigin(origin?: string) {
    if (!origin || !allowedOrigins().includes(origin)) {
      throw new Error(`허용되지 않은 출처입니다: ${origin ?? '(없음)'}`);
    }
  }

  /**
   * 이 접속이 이 테이블을 볼 자격이 있는지 확인한다.
   *
   * 판정 자체는 `PlaysyncService.assertTableAccess`에 있다 — REST
   * (`playsync.controller.ts`의 `joinTable`)가 같은 자원을 여는 두 번째
   * 문이라, 규칙을 여기 두 벌로 두면 한쪽만 고쳐지는 날이 온다(T66).
   * 이 메서드는 `handleConnection`의 호출부만 남긴 얇은 위임이다.
   *
   * `handleConnection`은 `catch (err)`에서 `err.message`만 로그로 남기고
   * 소켓을 닫으므로, 서비스가 던지는 것이 `Error`든 Nest 예외든 상관없다 —
   * 둘 다 `Error`를 상속한다.
   */
  private async assertTableAccess(payload: WsIdentity, tableId: string) {
    await this.playsync.assertTableAccess(payload, tableId);
  }

  /**
   * 이 접속이 이 대회의 좌석 현황(`renderSeatList`)을 구독할 자격이 있는지
   * 확인한다. `assertTableAccess`와 같은 규칙이다 — **클라이언트가 보낸 값을
   * 근거로 삼지 않는다.**
   *
   * 이 검사가 없던 동안, 인증만 되면 아무 대회의 좌석 현황이나 실시간으로
   * 받아볼 수 있었다. 좌석 배치는 어느 테이블에 몇 명이 남았는지를 그대로
   * 드러낸다. 테이블 경로는 바로 아래에서 막고 있었으므로, 대회 경로만
   * 뚫려 있던 비대칭 자체가 빠뜨렸다는 증거다.
   *
   * **티켓에 `tournamentId`가 없는 것은 결함이 아니다.** `POST /ws/ticket`은
   * 딜러 티켓에만 그 값을 싣는다(`WsTicketController.issue`) — 딜러는 대회
   * 하나에 묶인 세션이지만, 플레이어와 상점 계정은 한 사람이 여러 대회에
   * 걸칠 수 있어 발급 시점에 대회를 정할 수 없다. 그래서 거절하지 않고
   * **다른 근거로** 가른다.
   */
  private async assertTournamentAccess(payload: WsIdentity, tournamentId: string) {
    // 티켓이 대회를 들고 있으면(딜러) 그것이 권위다. `loginDealer`가 서명해
    // 넣은 값이라 클라이언트가 고를 수 없다.
    if (payload.tournamentId) {
      if (payload.tournamentId !== tournamentId) {
        throw new Error('토큰에 없는 대회입니다.');
      }
      return;
    }

    // 나머지는 서버가 들고 있는 관계로 정한다. 참가 행이 있거나, 그 대회를
    // 여는 상점의 주인이면 좌석 현황을 볼 자격이 있다 — 상점 콘솔과 전광판이
    // 그 화면이라 주인을 빼면 자기 대회에서 잠긴다.
    //
    // 참가 상태(`PlayerStatus`)는 보지 않는다. 탈락자에게도 좌석 현황은 이미
    // 본 정보고, 리바인을 기다리는 화면이 이 신호를 듣는다 — 상태로 자르면
    // 탈락과 동시에 그 화면이 죽는다.
    const allowed = await this.prisma.tournament.findFirst({
      where: {
        id: tournamentId,
        OR: [
          { tornamentParticipations: { some: { userId: payload.sub } } },
          { store: { ownerId: payload.sub } },
        ],
      },
      select: { id: true },
    });
    if (!allowed) throw new Error('이 대회를 볼 자격이 없습니다.');
  }

  // 1. 연결 시 토큰 검증 및 테이블 입장
  async handleConnection(client: WebSocket, request: any) {
    try {
      const url = new URL(request.url, `http://${request.headers['host']}`);
      const tableId = url.searchParams.get('tableId');
      const ticket = url.searchParams.get('ticket');
      const tournamentId = url.searchParams.get('tournamentId');

      this.assertAllowedOrigin(request.headers['origin']);

      if (!ticket) throw new Error('필수 정보 누락');

      // 신뢰의 출처가 티켓 소비다. 게이트웨이는 JWT를 보지 않는다 — 액세스
      // 토큰은 애초에 여기까지 오지 않는다.
      const payload = await this.tickets.consume(ticket);
      if (!payload) throw new Error('유효하지 않은 티켓입니다.');

      // 소켓 객체에 유저 정보 저장 (나중에 액션 시 사용)
      (client as any).userId = payload.sub;
      (client as any).role = payload.role;
      if (payload.tournamentId) {
        (client as any).tournamentId = payload.tournamentId;
      }

      // 1. 대회 단위 접속 (테이블 지정 없음) — 좌석 현황(`SEAT_LIST_UPDATED`)
      //    브로드캐스트를 받는 용도다.
      if (tournamentId && !tableId) {
        await this.assertTournamentAccess(payload, tournamentId);

        (client as any).tournamentId = tournamentId;
        this.addToMap(this.tournamentSessions, tournamentId, client);
        return; // 테이블 세션에는 넣지 않는다
      }

      // 2. 테이블 진입 시 (게임 시작 후)
      if (tableId) {
        await this.assertTableAccess(payload, tableId);

        (client as any).tableId = tableId;
        this.addToMap(this.tableSessions, tableId, client);

        // 접속자 본인에게만 보낸다. 남이 접속했다고 테이블 전원이 같은 상태를
        // 다시 받을 이유가 없다.
        const state = await this.redis.getSnapShot(tableId);
        const wire = this.toWireState(state);
        if (wire) client.send(JSON.stringify({ event: 'renderGame', data: wire }));
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

  /**
   * 스냅샷을 계약의 **공개형**으로 좁힌다. 어기면 `null`이다.
   *
   * `renderGame`으로 나가는 모든 자리가 여기를 지난다(T71 9-1). 예전에는
   * 게이트웨이가 백엔드 `TableState`를 원시 객체로 그대로 쏴서,
   * `table-state.ts` 머리말이 약속한 "여기 없는 필드는 조용히 제거된다"가
   * 이 경로에서만 거짓이었다 — 실제로 `timerEpoch`(타이머 세대)와 좌석마다
   * 반복되는 `tableId`가 참가자 단말까지 나가고 있었다.
   *
   * **던지지 않고 `null`을 돌려준다.** 계약 위반은 칩 정합이 깨졌다는 신호라
   * 깨진 상태를 그리는 것보다 안 그리는 편이 낫지만, 던지면
   * `handleGameStateUpdated`(`@OnEvent`)에서 처리되지 않은 거부가 되어
   * 테이블이 이유 없이 멈춘다 — 나올 길 없는 정지는 T62에서 한 번 겪었다.
   * 상태는 Redis에 남아 있으므로 다음 정상 전파가 복구한다.
   */
  private toWireState(state: unknown): WireTableState | null {
    const parsed = TableStateSchema.safeParse(state);
    if (!parsed.success) {
      this.logger.error(`renderGame 계약 위반 — 전파하지 않는다: ${parsed.error.message}`);
      return null;
    }
    // **보내는 순간의 서버 시각을 찍는다.** 스냅샷에는 없는 값이다 — 저장하면
    // 저장 시각이 되어 재접속 단말이 낡은 도장을 받는다.
    //
    // 단말은 이 값으로 자기 시계와의 오프셋을 재고, `actionDeadline`을 그
    // 보정된 시각과 비교한다(`ActionTimer`). 없으면 시계가 뒤처진 태블릿은
    // 게이지가 남은 채 자동 폴드된다.
    return { ...parsed.data, serverTime: Date.now() };
  }

  /** `renderGame` 브로드캐스트의 유일한 입구. */
  private broadcastRenderGame(tableId: string, state: unknown) {
    const wire = this.toWireState(state);
    if (!wire) return;
    this.broadcastToTable(tableId, 'renderGame', wire);
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

      // 아무것도 바뀌지 않았으면(턴이 아닌 사람의 액션) 전파하지 않는다.
      // 같은 스냅샷을 테이블 전원에게 다시 배달할 뿐이고, 30초마다 아무
      // 액션이나 던지는 클라이언트가 그대로 증폭기가 된다(T65).
      if (!updatedState) return;

      // 해당 테이블의 모든 인원에게 변경된 상태 브로드캐스트
      this.broadcastRenderGame(tableId, updatedState);
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
      this.broadcastRenderGame(tableId, updatedState);
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
        return this.dealer.resolveWinners(tableId, tournamentId, action.winnerGroups);
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
    this.broadcastRenderGame(payload.tableId, payload.state);
  }

  @OnEvent('SEAT_LIST_UPDATED')
  handleSeatListUpdated(payload: { tournamentId: string; state: any }) {
    this.broadcastToTournament(payload.tournamentId, 'renderSeatList', payload.state);
  }

  /**
   * 대회가 닫혔다고 단말에 알린다(`SessionService.announceClosed`).
   *
   * **테이블 방으로 간다.** 딜러와 좌석 태블릿이 거기 있고, 그들이 이 사실을
   * 모르면 끝난 대회의 마지막 스냅샷을 계속 그린다 — 그 상태에서 무엇을
   * 누르든 돌아오는 것은 「명령이 거절되었습니다」뿐이다.
   *
   * **`tableIds`가 페이로드에 실려 온다.** 부르는 쪽의 트랜잭션이 `Table`
   * 행을 이미 지웠으므로 여기서 조회할 수 없다.
   *
   * **소켓을 닫지는 않는다.** 단말이 「끝났습니다」를 읽고 스스로 대기 화면으로
   * 돌아가는데, 서버가 먼저 끊으면 화면은 연결 끊김 배너를 그린다 — 대회가
   * 끝난 것과 망이 끊긴 것은 딜러에게 전혀 다른 사건이다.
   */
  @OnEvent('TOURNAMENT_CLOSED')
  handleTournamentClosed(payload: { tournamentId: string; tableIds: string[]; status: string }) {
    // **계약을 태운다.** 여기 실리는 값이 그대로 화면의 문장을 고르므로,
    // 살아 있는 상태가 새어 나가면 대회가 도는 채로 「끝났습니다」가 뜬다.
    // `toWireState`와 같은 이유로 던지지 않는다 — `@OnEvent` 안의 거부는
    // 처리되지 않은 채로 남는다.
    const parsed = TournamentClosedSchema.safeParse({
      tournamentId: payload.tournamentId,
      status: payload.status,
      closedAt: Date.now(),
    });
    if (!parsed.success) {
      this.logger.error(`tournamentClosed 계약 위반 — 전파하지 않는다: ${parsed.error.message}`);
      return;
    }
    for (const tableId of payload.tableIds) {
      this.broadcastToTable(tableId, 'tournamentClosed', parsed.data);
    }
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
