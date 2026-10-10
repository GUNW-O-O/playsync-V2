import { ForbiddenException, Logger, ServiceUnavailableException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Role, TournamentStatus } from '@prisma/client';
import {
  DealerAction,
  DealerActionSchema,
  KEEPALIVE_EVENT,
  PlayerActionSchema,
  RebuyResponseSchema,
  ServerOutageSchema,
  TableStateSchema,
  TableState as WireTableState,
  TournamentClosedSchema,
  TournamentSyncingSchema,
  TournamentSyncing,
  SyncStatus,
  SyncStatusSchema,
  DEALER_REVOKED_REASON,
  SERVER_OUTAGE_EVENT,
  SERVER_RECOVERING_MESSAGE,
  SESSION_REVOKED_CLOSE_CODE,
  TOURNAMENT_SYNCING_EVENT,
} from '@playsync/contract';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { DealerService } from 'src/dealer/dealer.service';
import { assertSeatTokenCurrent } from 'src/entry/seat-token';
import { TableState } from 'src/game-engine/types';
import { PlaysyncService } from 'src/playsync/playsync.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RecoveryService } from 'src/recovery/recovery.service';
import { RedisService } from 'src/redis/redis.service';
import { dealerProbeMs, isSilent, markAlive, probe, socketPingMs, sweep } from './keepalive';
import { RequiredTable, syncProgress, TablePresence } from './sync-progress';
import { event, observe, timed } from 'src/metrics/stage-timer';
import { dealerGoneGraceMs, SyncQueue, syncRecountHoldMs } from './sync-queue';
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
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsGateway.name);

  // 토너먼트 전체 (예매, 공지용)
  private tournamentSessions = new Map<string, Set<WebSocket>>();
  // 개별 테이블 (게임 플레이용)
  private tableSessions = new Map<string, Set<WebSocket>>();

  // T97. `off`로 떼려면 리스너 참조를 들고 있어야 한다 — 인라인 화살표 함수는
  // 매번 새 함수라 `off`에 같은 값을 못 준다(`onModuleDestroy` 참고).
  private readonly onOutageDown = () => this.broadcastOutage(true);
  private readonly onOutageRecovered = () => { void this.afterOutage(); };

  // 재접속 대비 리바인 팝업 기록. `REBUY_PROMPT`는 이벤트라 창이 열린 동안
  // 좌석 소켓이 끊겼다 다시 붙으면 원래 발송을 놓친다 — 이 기록이 있어야
  // `handleConnection`이 재접속한 좌석에 같은 팝업을 다시 보낼 수 있다.
  // 메모리로 충분한 이유: 게이트웨이는 단일 인스턴스라 재시작이 곧 이
  // 대기의 끝이고, 그때는 `PlaysyncService.waitForRebuyResponse`도 함께
  // 끊겨 서버가 더 기다리지 않으므로 잃을 것이 없다. 추가 타이머는 두지
  // 않는다 — 만료된 항목은 읽는 자리(재전송 시도)에서 지운다.
  //
  // `generation`은 와이어로 나가지 않는다(M2, 최종 리뷰) — 기록 당시의
  // `RedisOutage.generation`이다. `markRecovered`와 `markRebuyInterrupted`의
  // 쓰기 사이에는 스냅샷의 `rebuyPending`이 아직 그 사람을 이고 마감도 살아
  // 있을 수 있지만, 서버는 이미 그 대기를 인터럽트로 접었다 — 이 세대가
  // 그때의 것과 다르면(장애가 한 번 났다 갔으면 항상 다르다, `onLost`가 감지
  // 즉시 올리므로) 아무도 듣지 않는 낡은 프롬프트다.
  private readonly pendingRebuyPrompts = new Map<string, {
    deadline: number; userPoints: any; entryFee: number; tournamentName: string; generation: number;
  }>();

  constructor(
    private readonly dealer: DealerService,
    private readonly playsync: PlaysyncService,
    private readonly redis: RedisService,
    private readonly tickets: WsTicketService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly recovery: RecoveryService,
  ) {
    // T97. 끊긴 순간과 복구가 끝난 순간을 화면에 알린다. 복구 뒤 n/n은
    // 부팅 뒤와 같은 재집계로 센다 — 소켓이 안 끊겼으므로 보통 곧바로 찬다.
    this.redis.outage.on('down', this.onOutageDown);
    this.redis.outage.on('recovered', this.onOutageRecovered);
  }

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 좀비 소켓 청소를 시작한다(T96). 게이트웨이에 하트비트가 없던 동안 반만
   * 닫힌 TCP가 방에 `OPEN`으로 남았다 — 기기 복귀를 소켓으로 세려면
   * (`SYNCING`의 n/n) 그 수가 사실이어야 한다.
   *
   * 테스트는 게이트웨이를 `new`로 세우므로 이 훅이 돌지 않는다. 틱은
   * `sweepSockets`를 직접 불러 잰다.
   */
  onModuleInit() {
    this.pingTimer = setInterval(() => this.sweepSockets(), socketPingMs());
    // 이 타이머가 이벤트 루프를 붙잡아 프로세스 종료를 막지 않게 한다
    // (`HeartbeatService.onApplicationBootstrap`과 같은 이유). 없으면
    // `WsModule`을 `app.init()`하고 `close()`를 빠뜨린 스펙에서 jest가
    // 끝나지 않는다.
    this.pingTimer.unref();
    // 딜러만 더 자주 확인한다(T121). 끊지는 않는다 — `probeDealers`.
    this.probeTimer = setInterval(() => this.probeDealers(), dealerProbeMs());
    this.probeTimer.unref();
  }

  onModuleDestroy() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    // T97. 안 떼면 이 인스턴스가 공유 `RedisOutage`에 영원히 남는다 — 테스트가
    // 게이트웨이를 `new`로 여러 번 세우는 자리(M4)에서 리스너가 쌓인다.
    this.redis.outage.off('down', this.onOutageDown);
    this.redis.outage.off('recovered', this.onOutageRecovered);
  }

  /**
   * pong을 받았다. 침묵하던 딜러가 답한 것이면(T121) 그 자리에서 다시 붙은 것으로 치고
   * 그 대회를 다시 센다 — 소켓이 안 끊겼으니 접속 이벤트가 따로 오지 않는다.
   */
  private onPong(client: any) {
    const wasSilent = isSilent(client);
    markAlive(client);
    if (!wasSilent) return;
    client.probeMisses = 0;
    if (client.role === Role.DEALER && client.tournamentId) {
      void this.reportSync(client.tournamentId).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
    }
  }

  /**
   * 딜러 빠른 확인 한 틱(T121). 테이블 방의 딜러 소켓에만 ping을 보내고, **그 대회의
   * 딜러가 전부 침묵이면** 대회를 멈춘다 — 10초 주기의 청소(`sweepSockets`)로는 회선이
   * 끊긴 것을 10~20초 뒤에 알고, 그 사이 마감이 온 사람이 접힌다.
   *
   * **끊지 않는다.** 침묵한 소켓은 「없는 딜러」로만 센다(`hasDealer` · `tablePresence`).
   * 와이파이가 몇 초 흔들린 것이면 답이 돌아오는 순간 그 소켓 그대로 이어 간다(`onPong`).
   * 정말 죽은 소켓은 청소가 치운다.
   */
  probeDealers() {
    const now = Date.now();
    const seen = new Map<string, { anyAnswering: boolean; lastAliveAt: number }>();
    for (const sessions of this.tableSessions.values()) {
      for (const s of sessions) {
        const socket = s as any;
        if (socket.wasTableDealer !== true || socket.readyState !== WebSocket.OPEN) continue;
        probe(socket, now);
        const t = seen.get(socket.tournamentId) ?? { anyAnswering: false, lastAliveAt: 0 };
        if (!isSilent(socket)) t.anyAnswering = true;
        t.lastAliveAt = Math.max(t.lastAliveAt, socket.aliveAt ?? 0);
        seen.set(socket.tournamentId, t);
      }
    }
    for (const [tournamentId, t] of seen) {
      // 판정은 `pauseIfNoDealer`가 다시 한다. 여기서 거르는 것은 틱마다 전 방을 또 훑지 않으려는 것뿐이다.
      if (t.anyAnswering) continue;
      this.lastDealerSeenAt.set(tournamentId, Math.max(this.lastDealerSeenAt.get(tournamentId) ?? 0, t.lastAliveAt));
      void this.pauseIfNoDealer(tournamentId);
    }
  }

  /** 한 틱. 두 방(대회 · 테이블)의 소켓 전부. */
  sweepSockets() {
    const message = JSON.stringify({ event: KEEPALIVE_EVENT });
    const all = new Set<any>();
    for (const set of this.tableSessions.values()) for (const s of set) all.add(s);
    for (const set of this.tournamentSessions.values()) for (const s of set) all.add(s);
    const dead = sweep(all, message);
    // 운영에서 이 PR의 목적(소켓 수를 믿는다)을 확인할 유일한 관측값이다.
    // 소켓마다 남기지 않는다 — 틱마다 한 줄이면 충분하고, 대량으로 끊기는
    // 순간에 로그가 그 자체로 다른 문제가 되지 않게 한다.
    if (dead.length > 0) {
      this.logger.warn(`응답 없는 소켓 ${dead.length}개를 끊었다`);
    }
    // `terminate()`는 `ws`가 `close`를 내게 해 `handleDisconnect`가 따로 불리지만,
    // 여기서 먼저 빼 둔다 — 뒤이은 호출은 `handleDisconnect`의 `disconnectHandled`
    // 표시가 걸러, 정리는 한 번만 돈다.
    for (const socket of dead) {
      // 응답이 없어 서버가 끊은 것과 상대가 닫은 것을 측정이 가른다(T121).
      (socket as any).swept = true;
      this.handleDisconnect(socket as unknown as WebSocket);
    }
  }

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
   * 딜러와 좌석 티켓(T110)에만 그 값을 싣는다(`WsTicketController.issue`) — 둘은
   * 대회 하나에 묶인 세션이지만, 플레이어와 상점 계정은 한 사람이 여러 대회에
   * 걸칠 수 있어 발급 시점에 대회를 정할 수 없다. 그래서 거절하지 않고
   * **다른 근거로** 가른다.
   */
  private async assertTournamentAccess(payload: WsIdentity, tournamentId: string) {
    // 티켓이 대회를 들고 있으면(딜러 · 좌석) 그것이 권위다. `loginDealer`와
    // `enterSeat`가 서명해 넣은 값이라 클라이언트가 고를 수 없다.
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
    const connectStart = performance.now();
    try {
      const url = new URL(request.url, `http://${request.headers['host']}`);
      const tableId = url.searchParams.get('tableId');
      const ticket = url.searchParams.get('ticket');
      const tournamentId = url.searchParams.get('tournamentId');

      this.assertAllowedOrigin(request.headers['origin']);

      if (!ticket) throw new Error('필수 정보 누락');

      // 신뢰의 출처가 티켓 소비다. 게이트웨이는 JWT를 보지 않는다 — 액세스
      // 토큰은 애초에 여기까지 오지 않는다.
      const payload = await timed('ws.consume', () => this.tickets.consume(ticket));
      if (!payload) throw new Error('유효하지 않은 티켓입니다.');

      // T110. 티켓은 30초 산다. 그 사이 세대가 오르면 발급 때 맞던 것이 지금은
      // 틀리다 — 세대를 올리는 쪽이 소켓을 닫는 것은 「이미 붙은」 것뿐이라
      // 여기서 한 번 더 본다.
      try {
        await timed('ws.identity', () => this.assertIdentityCurrent(payload));
      } catch (e) {
        // 낡은 토큰은 4001 — 클라가 재연결을 멈춘다. 그 밖의 오류는 아래 1008.
        if (!(e instanceof ForbiddenException)) throw e;
        this.logger.warn(`연결 거부: ${e.message}`);
        client.close(SESSION_REVOKED_CLOSE_CODE, e.message);
        return;
      }

      // 소켓 객체에 유저 정보 저장 (나중에 액션 시 사용)
      (client as any).userId = payload.sub;
      (client as any).role = payload.role;
      if (payload.tournamentId) {
        (client as any).tournamentId = payload.tournamentId;
      }

      // 좀비 판정의 근거(T96). 브라우저는 ping에 자동으로 pong한다.
      markAlive(client as any);
      (client as any).on('pong', () => this.onPong(client));

      // 1. 대회 단위 접속 (테이블 지정 없음) — 좌석 현황(`SEAT_LIST_UPDATED`)
      //    브로드캐스트를 받는 용도다.
      if (tournamentId && !tableId) {
        await this.assertTournamentAccess(payload, tournamentId);

        (client as any).tournamentId = tournamentId;
        this.addToMap(this.tournamentSessions, tournamentId, client);
        await this.closeIfStale(client, payload);
        return; // 테이블 세션에는 넣지 않는다
      }

      // 2. 테이블 진입 시 (게임 시작 후)
      if (tableId) {
        await timed('ws.tableAccess', () => this.assertTableAccess(payload, tableId));

        (client as any).tableId = tableId;
        this.addToMap(this.tableSessions, tableId, client);
        if (await timed('ws.closeIfStale', () => this.closeIfStale(client, payload))) return;
        // 여기까지 온 딜러만 「그 대회의 딜러였다」(T121). 접속에서 거절된 소켓의 끊김이
        // 대회를 멈추면 안 된다.
        if (payload.role === Role.DEALER) (client as any).wasTableDealer = true;

        // 접속자 본인에게만 보낸다. 남이 접속했다고 테이블 전원이 같은 상태를
        // 다시 받을 이유가 없다.
        const state = await timed('ws.snapshot', () => this.redis.getSnapShot(tableId));
        // T117. 좌석 소켓은 자기 자리 번호를 들고 다닌다 — 재집계가 스냅샷을
        // 다시 읽지 않고 이 값으로 「그 자리가 돌아왔나」를 센다(`tablePresence`).
        // 열린 소켓의 자리는 바뀌지 않는다 — 자리 해제는 좌석 토큰을 폐기하고
        // (`SEAT_TOKENS_REVOKED` → 4001 종료 → `handleDisconnect` 재집계), 재진입은
        // 새 티켓이 필요하다. 그래서 접속 때 한 번 적어 두면 된다.
        if (payload.role !== Role.DEALER && state) {
          const seatIndex = state.players.findIndex((p) => p?.id === payload.sub);
          if (seatIndex >= 0) {
            (client as any).seatIndex = seatIndex;
            (client as any).syncTournamentId = state.tournamentId;
          }
        }
        const wire = this.toWireState(state);
        if (wire) client.send(JSON.stringify({ event: 'renderGame', data: wire }));
        // 여기까지가 단말이 「붙었다」고 느끼는 시간이다 — 뒤의 재집계는 뺀다.
        observe(payload.role === Role.DEALER ? 'ws.connect.dealer' : 'ws.connect.seat', performance.now() - connectStart);
        event('ws.back', {
          role: payload.role === Role.DEALER ? 'dealer' : 'seat',
          tournament: payload.tournamentId ?? state?.tournamentId,
          table: tableId,
        });

        // 복구 중에 붙었다(T97). 서버가 새 이벤트를 보장할 수 없는 자리라 붙는
        // 쪽이 매번 확인한다 — T96 `recount`의 joiner와 같은 이유다.
        if (!this.redis.outage.isUp()) {
          client.send(JSON.stringify({ event: SERVER_OUTAGE_EVENT, data: ServerOutageSchema.parse({ down: true }) }));
        } else if (payload.role !== Role.DEALER && state) {
          // 재접속한 좌석 — 서버가 아직 리바인 응답을 기다리고 있으면
          // (`rebuyPending`에 내 자리가 있으면) 놓쳤을 팝업을 다시 보낸다.
          // 반드시 `renderGame` 뒤다 — 좌석 화면은 `rebuyPending`이 내 자리를
          // 싣지 않으면 팝업 버튼을 막는다(T100).
          this.resendPendingRebuyPrompt(tableId, payload.sub, state, client);
        }

        // 딜러가 돌아왔다 — 그 대회가 SYNCING이면 다시 세어 본다(T96).
        // 부수 작업(집계)의 순간 장애가 바깥 catch로 새면, 방금 인증에
        // 성공한 딜러 소켓이 "인증 실패"로 끊긴다(M1) — 여기서 삼킨다.
        //
        // **이 소켓을 `recount`에 함께 넘긴다**(최종 리뷰 I2). 대회가 이미
        // SYNCING이 아니면 그 자리에서 이 소켓에만 `{syncing:false}`를 알려
        // 준다 — 완료 순간에 좀비였던 소켓, `required`에서 이미 빠진 테이블,
        // n→0으로 끝난 경우처럼 서버가 새 이벤트를 보장할 수 없는 자리들을
        // "붙는 쪽이 매번 확인한다"로 전부 없앤다.
        // 실패는 `reportSync`의 체인이 이미 로그로 남긴다(M7) — 여기서
        // 또 찍으면 같은 실패가 두 줄로 남는다. 여기서는 삼키기만 한다.
        if (payload.role === Role.DEALER && payload.tournamentId) {
          await this.reportSync(payload.tournamentId, client).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
        }

        // 좌석이 돌아왔다 — 그 대회가 SYNCING이면 다시 센다(T117). 실패는
        // 딜러 블록과 같은 이유로 삼킨다(M1 · M7).
        const seatTournament = (client as any).syncTournamentId as string | undefined;
        if (seatTournament) {
          await this.reportSync(seatTournament).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
        }
      }

    } catch (err) {
      // 거부된 접속은 보안 신호다. 잘못된 토큰과 허용되지 않은 출처가
      // 여기로 모인다.
      this.logger.warn(`연결 거부: ${err.message}`);
      observe('ws.connect.rejected', performance.now() - connectStart);
      client.close(1008, '인증 실패');
    }
  }

  // 2. 연결 종료 시 세션 제거
  async handleDisconnect(client: WebSocket) {
    const tableId = (client as any).tableId;
    const tournamentId = (client as any).tournamentId;
    const role = (client as any).role;

    // **한 소켓의 정리는 한 번만 돈다.** `sweepSockets`가 `terminate()` 뒤 이
    // 메서드를 직접 부르고, 곧이어 `ws`의 `close` 이벤트가 같은 소켓에 다시
    // 부른다(T96). 두 번째 호출이 딜러 재집계를 또 쏘면 안 된다.
    //
    // **그 판정을 `Set.delete`의 반환값으로 하면 안 된다**(T96 잔여). 방에서
    // 빼는 자리가 여기만이 아니다 — `broadcast`가 OPEN이 아닌 소켓을 그 자리에서
    // 지운다. 그러면 뒤이은 진짜 `handleDisconnect`가 `delete === false`를 보고
    // **재집계를 통째로 건너뛰어**, 「k/n 복귀」 표시가 다음 이벤트까지 높게
    // 남았다. 소켓 자신에 표시를 남기면 누가 먼저 방에서 뺐든 상관이 없다.
    const marker = client as unknown as { disconnectHandled?: boolean };
    if (marker.disconnectHandled) return;
    marker.disconnectHandled = true;
    if (tableId) {
      event('ws.gone', {
        role: role === Role.DEALER ? 'dealer' : 'seat',
        tournament: tournamentId ?? (client as any).syncTournamentId,
        table: tableId,
        swept: (client as any).swept === true,
      });
    }

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

    // 끊긴 소켓이 딜러면 그 대회의 복귀 집계가 하나 줄었을 수 있다(T96).
    // `sweepSockets`는 이 메서드를 기다리지 않고 부른다(기존 동작 유지) —
    // 실패해도 여기서 삼키므로 처리되지 않은 거부로 새지 않는다. 로그는
    // `reportSync`의 체인이 이미 남긴다(M7) — 여기서 또 찍지 않는다.
    if (role === Role.DEALER && tournamentId) {
      // 그 대회의 마지막 딜러였으면 회선이 끊긴 것이다(T121). 재집계보다 먼저 줄에
      // 세운다 — 재집계는 보류 창(`SYNC_RECOUNT_HOLD_MS`)만큼 늦게 시작한다.
      let paused: Promise<void> = Promise.resolve();
      // 테이블이 닫혀 서버가 끊은 딜러는 회선이 끊긴 것이 아니다(T126) — 여기서 기록하면
      // 닫힌 대회의 항목이 다시 적혀 남는다.
      if ((client as any).wasTableDealer === true && (client as any).closedByServer !== true) {
        const swept = (client as any).swept === true;
        const seenAt = swept ? (client as any).aliveAt ?? Date.now() : Date.now();
        this.lastDealerSeenAt.set(tournamentId, Math.max(this.lastDealerSeenAt.get(tournamentId) ?? 0, seenAt));
        // **스스로 닫은 소켓만 유예를 준다.** 새로고침과 화면 이동은 몇 초 안에 다시
        // 붙는다 — 딜러가 한 대뿐인 파이널 테이블에서 그것으로 대회가 멈추면 안 된다.
        // 응답이 없어 끊은 소켓(회선)과 서버가 내보낸 소켓(OTP 재발급 · 기기 해제)은
        // 돌아올 새로고침이 아니라 곧바로 본다.
        const immediate = swept || (client as any).revokedByServer === true;
        paused = this.pauseIfNoDealer(tournamentId, immediate ? 0 : this.dealerGoneGraceMs);
      }
      await this.reportSync(tournamentId).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
      await paused;
    }

    // 끊긴 소켓이 좌석이면 그 대회의 복귀 집계가 하나 줄었을 수 있다(T117).
    const seatTournament = (client as any).syncTournamentId as string | undefined;
    if (seatTournament) {
      await this.reportSync(seatTournament).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
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

  /** 테이블 방의 소켓 전원에게. 소켓 화면은 좌석·딜러 둘뿐이다. */
  private broadcastOutage(down: boolean) {
    const data = ServerOutageSchema.parse({ down });
    for (const tableId of [...this.tableSessions.keys()]) {
      this.broadcastToTable(tableId, SERVER_OUTAGE_EVENT, data);
    }
  }

  /**
   * 복구가 끝났다(T97). 멈춘 테이블의 새 스냅샷을 다시 그리게 하고, 대회마다
   * n/n을 센다. **Redis를 다시 읽는다** — 스윕이 쓴 `resumePending`이 거기 있다.
   */
  private async afterOutage() {
    this.broadcastOutage(false);
    for (const tableId of [...this.tableSessions.keys()]) {
      try {
        this.broadcastRenderGame(tableId, await this.redis.getSnapShot(tableId));
      } catch (e) {
        this.logger.error(`복구 뒤 renderGame 실패 (table=${tableId})`, e as Error);
      }
    }
    const live = await this.prisma.tournament
      .findMany({ where: { status: TournamentStatus.SYNCING }, select: { id: true } })
      .catch((e) => { this.logger.error('복구 뒤 대회 조회 실패', e); return []; });
    for (const t of live) {
      await this.reportSync(t.id).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
    }
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
  //
  // I1(최종 리뷰): 여기서 첫 소켓을 찾고 멈추면(과거의 `break`), 좀비 소켓이
  // keepalive 스윕(10~20초) 전까지 테이블 집합에 OPEN 상태로 먼저 들어 있는 채
  // 남아 있는 동안 재접속한 새 소켓은 이벤트를 못 받는다 — 재접속 시점의
  // `resendPendingRebuyPrompt`는 이미 끝난 뒤라 다시 보낼 길이 없다. 같은
  // userId의 OPEN 소켓 전부에 보낸다.
  private sendToTableUser(tableId: string, userId: string, event: string, data: any) {
    const sessions = this.tableSessions.get(tableId);
    if (sessions) {
      // 해당 테이블에 접속한 소켓들 중 userId가 일치하는 소켓 전부에 보낸다
      for (const socket of sessions) {
        if ((socket as any).userId === userId && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event, data }));
        }
      }
    }
  }

  /** `pendingRebuyPrompts`의 키. 테이블·사람 단위라 응답도, 재전송도 이 키로 찾는다. */
  private rebuyPromptKey(tableId: string, userId: string) {
    return `${tableId}:${userId}`;
  }

  /**
   * 재접속한 좌석에 아직 열려 있는 리바인 창을 다시 알린다.
   *
   * `REBUY_PROMPT`는 이벤트라 못 받은 채 지나가면 서버
   * (`PlaysyncService.waitForRebuyResponse`)는 응답 없이 계속 기다리다 15초
   * 마감에 거절로 세고, 그 사람은 `resolveWinners` 3단계에서 탈락한다 —
   * 자리는 아직 살아 있는데 화면만 못 본 것뿐인데도.
   */
  private resendPendingRebuyPrompt(tableId: string, userId: string, state: TableState, client: WebSocket) {
    // **자리는 배열 위치다, `seatIndex` 필드가 아니다.**
    // `PlaysyncService.markRebuyPending`이 `seatIndexes`를 지을 때 쓰는 것은
    // `snapshot.players`의 배열 인덱스이지 좌석 객체의 `seatIndex` 필드가
    // 아니다 — 둘이 같다는 보장이 없다. 필드로 대조하면 어긋난 스냅샷에서
    // 조용히 못 찾는다.
    const seatPosition = state.players.findIndex((p) => p?.id === userId);
    if (seatPosition < 0) return;

    // 서버가 이 사람을 기다리지 않으면(`rebuyPending`에 내 자리가 없으면)
    // 보낼 이유가 없다. T100에서 `rebuyPending`은 매 프롬프트 전에 서고,
    // 판이 끝나거나 장애로 끊기면 지워진다.
    const rebuyPending = state.rebuyPending;
    if (!rebuyPending || !rebuyPending.seatIndexes.includes(seatPosition)) return;

    const key = this.rebuyPromptKey(tableId, userId);
    const prompt = this.pendingRebuyPrompts.get(key);
    if (!prompt) return;

    // 마감이 지난 기록은 추가 타이머 없이 이 읽는 자리에서 지운다.
    if (prompt.deadline <= Date.now()) {
      this.pendingRebuyPrompts.delete(key);
      return;
    }

    // **지난 라운드의 낡은 프롬프트를 걸러낸다.** 장애가 리바인 창을 끊으면
    // `PlaysyncService.markRebuyInterrupted`가 `rebuyPending`을 지우고, 딜러가
    // 재개하면 `DealerService.askRebuyRound`가 `markRebuyPending`으로 새
    // 마감을 스냅샷에 세운 **뒤에야** 사람마다 `processRebuy`가 DB를 읽고
    // `waitForRebuyResponse`로 새 프롬프트의 마감(`Date.now() + timeoutMs`)을
    // 잰다 — 항상 마커보다 늦거나 같다. 적어 둔 프롬프트의 마감이 지금
    // 마커보다 이르면, 그 프롬프트는 이번 라운드가 아니라 장애로 끊긴
    // 이전 라운드의 것이다. 그새 접속한 소켓에 그걸 다시 보내면 서버는
    // 이미 새 프롬프트를 기다리는데 단말은 답할 수 없는 낡은 팝업을 본다.
    if (prompt.deadline < rebuyPending.deadline) return;

    // **세대가 다르면 서버가 더는 기다리지 않는 프롬프트다(M2).** 복구
    // 직후부터 `markRebuyInterrupted`의 쓰기가 끝나기까지, 스냅샷은 아직
    // 이번 사람의 `rebuyPending`을 이고 마감도 미래일 수 있지만
    // `processRebuy`는 이미 `interrupted`로 끝나 리스너를 뗐다 — 응답을
    // 보내도 아무도 안 듣고 조용히 버려진다.
    if (prompt.generation !== this.redis.outage.generation) {
      this.pendingRebuyPrompts.delete(key);
      return;
    }

    const { deadline, userPoints, entryFee, tournamentName } = prompt;
    client.send(JSON.stringify({ event: 'REBUY_PROMPT', data: { deadline, userPoints, entryFee, tournamentName } }));
  }

  @SubscribeMessage('PLAYER_ACTION')
  async handlePlayerAction(@ConnectedSocket() client: any, @MessageBody() data: any) {
    // T110. 해제로 닫힌 소켓도 피어가 응답하거나 closeTimeout(30초)이 찰 때까지
    // 프레임이 계속 들어온다 — 닫히는 중이면 처리하지 않는다.
    if (client.readyState !== WebSocket.OPEN) return;

    const { tableId, userId, role } = client;

    // T97. Redis 장애 중에는 좌석 액션을 즉시 거절한다 — 예전엔 ioredis가
    // 7초 재시도한 뒤 원문 에러를 냈다.
    if (!this.redis.outage.isUp()) return { event: 'error', data: SERVER_RECOVERING_MESSAGE };

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
    // T110. 해제로 닫힌 소켓도 피어가 응답하거나 closeTimeout(30초)이 찰 때까지
    // 프레임이 계속 들어온다 — 닫히는 중이면 처리하지 않는다.
    if (client.readyState !== WebSocket.OPEN) return;

    const { tableId, role, tournamentId } = client;

    // T97. `recovering` 동안에도 딜러 명령을 받지 않는다 — 재개는 딜러와 좌석
    // 기기가 모두 돌아온 뒤라야 뜻이 있다(T117, SYNCING 가드와 같은 이유).
    if (!this.redis.outage.isUp()) return { event: 'error', data: SERVER_RECOVERING_MESSAGE };

    if (role !== Role.DEALER) return { event: 'error', data: '딜러만 가능한 액션입니다.' };

    const parsed = DealerActionSchema.safeParse(data);
    if (!parsed.success) {
      return { event: 'error', data: '잘못된 딜러 명령입니다.' };
    }
    const action = parsed.data;

    try {
      const updatedState = await this.runDealerAction(tournamentId, tableId, action);
      event('dealer.cmd', { action: action.action, tournament: tournamentId, table: tableId });
      this.broadcastRenderGame(tableId, updatedState);
    } catch (e) {
      return { event: 'error', data: e.message };
    }
  }

  /**
   * 대회별 재집계 줄(T96 리뷰 I1 · T117). 줄 세우기와 합치기의 이유는 `SyncQueue`에.
   */
  private readonly syncQueue = new SyncQueue<WebSocket>(
    (tournamentId, joiners) => this.recount(tournamentId, joiners),
    (e) => this.logger.error('SYNCING 재집계 실패', e),
    syncRecountHoldMs(),
  );

  /**
   * `recount`를 그 대회 줄에 세운다(T96 리뷰 I1). 끝나지 않은 재집계끼리는 어긋나지
   * 않지만 **끝난 판정의 `await completeSync` 창**에서는 어긋난다 — 줄이 있어야 뒤의
   * 재집계가 앞선 것이 상태를 커밋한 뒤에 읽어 낡은 `{syncing:true}`를 보내지 않는다.
   * 줄을 서는 방식과 같은 대회 요청을 합치는 이유는 `SyncQueue`에 있다.
   */
  private reportSync(tournamentId: string, joiner?: WebSocket): Promise<void> {
    return this.syncQueue.recountLater(tournamentId, joiner);
  }

  /**
   * 그 대회의 딜러가 마지막으로 응답한 시각(T121). 딜러 소켓이 끊길 때마다 최댓값으로
   * 적는다 — 응답이 없어 서버가 끊은 소켓은 마지막 pong, 상대가 닫은 소켓은 닫힌 지금이다.
   * 마지막 딜러가 사라지면 이 값이 `pausedAt`이 된다. 대회가 닫히면 지우지만
   * (`handleTournamentClosed`), 그 종료가 닫은 딜러 소켓의 `handleDisconnect`가 뒤이어
   * 다시 적는다 — 닫힌 대회의 항목은 프로세스가 내려갈 때까지 남는다.
   */
  private readonly lastDealerSeenAt = new Map<string, number>();
  /**
   * 상점이 그 대회를 강제로 푼 시각(T126, `forceSync`). **그 뒤로 답한 딜러가 없으면 회선
   * 탓으로 다시 멈추지 않는다** — 회선이 죽은 채 푼 것이면 딜러 소켓은 여전히 침묵 중이고,
   * 다음 확인 틱이 같은 `pausedAt`으로 대회를 되돌려 그 구간을 두 번 계상했다.
   */
  private readonly forcedAt = new Map<string, number>();
  /** 줄에서 아직 시작 안 한 「딜러 0」 확인. 한꺼번에 끊긴 딜러들이 하나로 합쳐진다. */
  private readonly pausePending = new Map<string, Promise<void>>();
  /** 스스로 닫은 마지막 딜러를 기다리는 시간과 그 타이머(대회별 하나). */
  private dealerGoneGraceMs = dealerGoneGraceMs();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 그 대회에 **답하고 있는** 딜러 소켓이 하나라도 있나. 빈 테이블의 딜러도 센다 — 회선이
   * 살아 있다는 증거다. 열려 있어도 빠른 확인에 침묵한 소켓은 안 센다(`probeDealers`).
   */
  private hasDealer(tournamentId: string): boolean {
    // ponytail: 전 테이블 방을 훑는다. 딜러 끊김마다 한 번이라 지금은 충분하다 —
    // 대회가 수천이면 대회별 딜러 소켓 집합을 따로 든다.
    for (const sessions of this.tableSessions.values()) {
      for (const s of sessions) {
        const socket = s as any;
        if (
          socket.role === Role.DEALER && socket.tournamentId === tournamentId &&
          socket.readyState === WebSocket.OPEN && !isSilent(socket)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 그 대회의 딜러 소켓이 하나도 안 남았으면 대회를 멈춘다(T121). 대회장의 회선이
   * 끊기면 서버는 소켓을 방에서 뺄 뿐이라, 차례인 사람이 30초마다 차례로 폴드됐다.
   *
   * **응답이 없어 끊은 소켓에는 유예가 없다.** 말없이 끊긴 소켓을 아는 데 이미 10~20초가
   * 걸리고(`SOCKET_PING_MS`), 딜러는 끊기면 40~50초 뒤에 붙는다(`reconnect-policy.ts`).
   * 서버가 내보낸 소켓도 같다. **스스로 닫은 소켓만 `graceMs`를 기다렸다 다시 본다** —
   * 새로고침이면 그 안에 돌아와 있다. 유예는 줄 밖에서 센다(줄을 막으면 재집계가 선다).
   *
   * **재집계와 같은 줄에 서고 줄 안에서 다시 본다** — 기다리는 사이 딜러가 붙었으면
   * 끊긴 것이 아니다. Redis 장애 중이면 그 길(`RecoveryService.onRedisDown`)이 이미 켰다.
   * 일부러 끊긴 마지막 딜러(기기 해제 · OTP 재발급)도 같은 기준이다.
   *
   * 멈춘 뒤 스냅샷을 다시 방송한다 — 멈춰 세우기는 Redis에만 쓴다. 일부러 끊긴
   * 경우에는 좌석이 붙어 있어, 안 보내면 낡은 마감 게이지를 계속 그린다.
   */
  private pauseIfNoDealer(tournamentId: string, graceMs = 0): Promise<void> {
    if (this.hasDealer(tournamentId)) return Promise.resolve();
    if (graceMs > 0) {
      // 다시 닫히면 그때부터 다시 센다 — 연달은 새로고침의 틈에 걸리지 않게.
      clearTimeout(this.graceTimers.get(tournamentId));
      const timer = setTimeout(() => {
        this.graceTimers.delete(tournamentId);
        void this.pauseIfNoDealer(tournamentId);
      }, graceMs);
      timer.unref();
      this.graceTimers.set(tournamentId, timer);
      return Promise.resolve();
    }
    const pending = this.pausePending.get(tournamentId);
    if (pending) return pending;
    const done = this.syncQueue.enqueue(tournamentId, async () => {
      // 시작하는 순간 합치기를 닫는다(`SyncQueue.recountLater`와 같다).
      this.pausePending.delete(tournamentId);
      if (!this.redis.outage.isUp() || this.hasDealer(tournamentId)) return;
      const seenAt = this.lastDealerSeenAt.get(tournamentId) ?? Date.now();
      const forcedAt = this.forcedAt.get(tournamentId);
      if (forcedAt !== undefined && seenAt <= forcedAt) return;
      const pausedAt = new Date(seenAt);
      if (!(await this.recovery.pauseForLineOutage(tournamentId, pausedAt))) return;
      event('tournament.paused', { tournament: tournamentId, pausedAt: pausedAt.getTime() });
      const seatMaps = await this.redis.getTournamentTables(tournamentId);
      for (const { tableId } of seatMaps) {
        if (!this.tableSessions.has(tableId)) continue;
        this.broadcastRenderGame(tableId, await this.redis.getSnapShot(tableId));
      }
    }).catch((e) => this.logger.error(`회선 끊김 판정 실패 (tournament=${tournamentId})`, e));
    this.pausePending.set(tournamentId, done);
    return done;
  }

  /** 회선 때문에 멈춘 대회면 그 원인(T121). 서버 장애면 키 자체를 싣지 않는다. */
  private syncReason(tournamentId: string): { reason?: 'lineDown' } {
    return this.redis.linePause.isDown(tournamentId) ? { reason: 'lineDown' } : {};
  }

  /**
   * 그 대회가 `SYNCING`이면 기기 복귀(딜러 + 앉은 자리)를 다시 세어 딜러들에게 알리고, n/n이면
   * 끝낸다(T96). **직접 부르지 않는다** — 항상 `reportSync`를 거쳐 대회별
   * 줄을 선다.
   *
   * **소켓 수를 판정에 쓴다.** T95가 피했던 것은 게이트웨이에 하트비트가 없어
   * 좀비가 살아 보였기 때문이고, 그 전제는 `sweepSockets`가 없앴다. 그래도
   * 좀비가 끼면 n/n이 조금 일찍 풀릴 뿐이다 — 판을 여는 것은 여전히 테이블마다
   * 딜러가 누르는 재개다.
   *
   * @param joiners 방금 접속한 딜러 소켓들(`handleConnection`에서만 넘긴다). 이
   *   대회가 SYNCING이 아니면 **이 소켓에만** `{syncing:false,0,0}`을
   *   알려 준다(최종 리뷰 I2) — 완료가 이미 끝난 뒤에 붙은 소켓은 그 뒤로
   *   서버가 새 이벤트를 보낼 자리가 없어, 붙는 순간 스스로 확인하게 한다.
   */
  private async recount(tournamentId: string, joiners: WebSocket[]) {
    // T97 최종 리뷰 I1. `recovering` 동안은 ioredis가 이미 다시 붙어 이
    // 함수의 Redis·DB 읽기는 멀쩡히 도는데, 복구 스윕(`RecoveryService.
    // recoverFromOutage`)이 아직 `freezeTournament`로 테이블을 얼리기
    // 전이다. 그 창에서 n/n을 세어 `completeSync`를 부르면 스윕의
    // `findMany({ status: SYNCING })`가 이 대회를 못 보고 지나가 테이블이
    // 영영 얼지 않고, 복구 뒤 낡은 마감이 차례인 사람을 접는다 — 이 티켓이
    // 닫는 결함 그대로다. 그래서 `up`이 아니면 여기서 아무것도 세지 않고
    // 돌아간다. `afterOutage`가 `markRecovered`로 `up`이 된 뒤 SYNCING
    // 대회를 다시 훑어 `reportSync`를 부르므로 n/n은 그때 다시 채워진다.
    // joiner(방금 접속한 딜러)는 `handleConnection`에서 이미
    // `serverOutage {down:true}`를 받아 화면이 막혀 있으므로, 여기서
    // SYNCING 띠를 못 받아도 화면상 문제가 없다.
    if (!this.redis.outage.isUp()) return;
    const recountStart = performance.now();
    observe('sync.joiners', joiners.length);
    const t = await timed('sync.status', () => this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } }));
    if (t?.status !== TournamentStatus.SYNCING) {
      for (const joiner of joiners) {
        if (joiner.readyState !== WebSocket.OPEN) continue;
        const payload = TournamentSyncingSchema.parse({ syncing: false, present: 0, required: 0 });
        try { joiner.send(JSON.stringify({ event: TOURNAMENT_SYNCING_EVENT, data: payload })); } catch { /* 다음 틱이 치운다 */ }
      }
      return;
    }

    const { seatMaps, progress } = await timed('sync.measure', () => this.measureSync(tournamentId));
    let syncing = true;
    // 끝내면 원인도 지워진다(`completeSync`) — 끝났다는 알림에는 싣지 않는다.
    let reason = this.syncReason(tournamentId);
    if (progress.done) {
      // **0/0이 유실일 수 있다**(T126). 테이블이 있는 대회는 빈 테이블도 좌석 해시에
      // 자리가 있다. 해시가 통째로 비었는데 DB에 테이블이 있으면 Redis가 데이터를
      // 잃은 것이라, 「다 돌아왔다」로 읽어 풀지 않는다 — 상점의 `forceSync`는 남는다.
      if (seatMaps.length === 0 && (await this.prisma.table.count({ where: { tournamentId } })) > 0) {
        this.logger.warn(`좌석 비트맵이 없어 SYNCING을 스스로 풀지 않는다 (tournament=${tournamentId})`);
        return;
      }
      // 진 쪽(동시 n/n)은 false다. 이긴 쪽이 알린다.
      if (!(await this.recovery.completeSync(tournamentId))) return;
      syncing = false;
      reason = {};
    }
    const sendStart = performance.now();
    this.sendSyncing(seatMaps, { syncing, present: progress.present, required: progress.required, ...reason });
    observe('sync.send', performance.now() - sendStart);
    observe('sync.recount', performance.now() - recountStart);
    observe(`sync.progress.${progress.present}/${progress.required}`);
  }

  /**
   * 상점 콘솔의 복구 상태(T117). 판정은 재집계와 같은 함수다 — 딜러 띠와 상점
   * 목록이 같은 숫자를 본다.
   */
  async syncStatus(tournamentId: string): Promise<SyncStatus> {
    const t = await this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } });
    if (t?.status !== TournamentStatus.SYNCING) {
      return SyncStatusSchema.parse({ syncing: false, present: 0, required: 0, missing: [] });
    }
    const { progress } = await this.measureSync(tournamentId);
    return SyncStatusSchema.parse({ syncing: true, ...progress, ...this.syncReason(tournamentId) });
  }

  /**
   * 상점의 「지금 진행」(T117). 참가자가 장애 뒤 아무 의사도 밝히지 않고 떠나면 그
   * 자리는 끝내 안 돌아와 대회가 영영 멈춘다 — 현장 판단으로 푼다. 안 돌아온 자리는
   * 평소 규칙대로 접히고 칩이 떨어지면 리바인 시간초과로 탈락한다.
   *
   * **재집계와 같은 줄에 선다** — 앞선 재집계가 낡은 `{syncing:true}`를 이 뒤에 보내지
   * 않게(T96 리뷰 I1). 자연 완료와 겹치면 `completeSync`의 조건부 갱신이 한쪽만
   * 이기게 한다.
   *
   * @param actorId 누가 강제했는지 로그에 남긴다(상점 사용자 id)
   * @returns 이 호출이 풀었으면 true. 이미 풀렸거나 진 쪽이면 false
   */
  async forceSync(tournamentId: string, actorId: string): Promise<boolean> {
    return this.syncQueue.enqueue(tournamentId, async () => {
      // T97 최종 리뷰 I1. `recount`와 같은 가드다. down·recovering 동안 풀면 복구 스윕의
      // `findMany({ status: SYNCING })`가 이 대회를 못 봐 테이블이 안 얼고 낡은 마감이
      // 차례인 사람을 접는다. false가 아니라 503인 이유: 409 「복구 중인 대회가
      // 아닙니다」는 거짓이다. 대기 중에 phase가 바뀔 수 있어 큐 안에서 확인한다.
      if (!this.redis.outage.isUp()) throw new ServiceUnavailableException(SERVER_RECOVERING_MESSAGE);
      const t = await this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } });
      if (t?.status !== TournamentStatus.SYNCING) return false;
      const { seatMaps, progress } = await this.measureSync(tournamentId);
      if (!(await this.recovery.completeSync(tournamentId))) return false;
      this.forcedAt.set(tournamentId, Date.now());
      this.logger.warn(
        `상점이 SYNCING을 풀었다 (tournament=${tournamentId}, actor=${actorId}, 기기 ${progress.present}/${progress.required})`,
      );
      this.sendSyncing(seatMaps, { syncing: false, present: progress.present, required: progress.required });
      return true;
    });
  }

  /**
   * 그 대회에 필요한 기기와 지금 붙은 기기(T117). 읽는 것은 비트맵 해시 하나다 —
   * 좌석 소켓의 자리 번호는 접속할 때 소켓에 적어 둔다(`handleConnection`).
   * 대회 하나에 1,400테이블이면 재집계마다 스냅샷을 읽을 수 없다.
   */
  private async measureSync(tournamentId: string) {
    const seatMaps = await this.redis.getTournamentTables(tournamentId);
    const required: RequiredTable[] = seatMaps
      .filter((m) => m.seatStatus.some(Boolean))
      .map((m) => ({ tableId: m.tableId, seats: m.seatStatus.flatMap((on, i) => (on ? [i] : [])) }));
    const presence = new Map(required.map((r) => [r.tableId, this.tablePresence(r.tableId)] as const));
    return { seatMaps, progress: syncProgress(required, presence) };
  }

  /** 그 테이블에 열린 딜러 소켓이 있나, 열린 좌석 소켓이 든 자리 번호들. */
  private tablePresence(tableId: string): TablePresence {
    let dealer = false;
    const seats = new Set<number>();
    for (const s of this.tableSessions.get(tableId) ?? []) {
      const socket = s as any;
      if (socket.readyState !== WebSocket.OPEN) continue;
      // 침묵한 딜러는 돌아온 것으로 안 센다(T121) — 세면 회선이 죽은 채로 n/n이 찬다.
      if (socket.role === Role.DEALER) dealer ||= !isSilent(socket);
      else if (typeof socket.seatIndex === 'number') seats.add(socket.seatIndex);
    }
    return { dealer, seats };
  }

  /**
   * 이 대회의 테이블 전부(`seatMaps`)의 딜러에게 보낸다 — 세는 쪽(`required`)만 돌면 빈
   * 테이블에 붙은 딜러와 n=0으로 끝난 경우 아무도 못 받는다(최종 리뷰 I2 · Task 4 M2).
   */
  private sendSyncing(seatMaps: { tableId: string }[], payload: TournamentSyncing) {
    const data = TournamentSyncingSchema.parse(payload);
    for (const m of seatMaps) {
      for (const s of this.tableSessions.get(m.tableId) ?? []) {
        if ((s as any).role !== Role.DEALER || s.readyState !== WebSocket.OPEN) continue;
        try { s.send(JSON.stringify({ event: TOURNAMENT_SYNCING_EVENT, data })); } catch { /* 다음 틱이 치운다 */ }
      }
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
    // **복구 중에는 딜러 명령을 전부 받지 않는다**(T96). 핸드 시작은 깜깜한
    // 좌석을 판에 넣고(30초 뒤 자동 폴드), 승자 입력은 리바인 창(15초)을 꺼진
    // 태블릿으로 보낸다. 재개는 딜러와 좌석 기기가 모두 돌아온 뒤라야 뜻이 있다(T117).
    const t = await this.prisma.tournament.findUnique({ where: { id: tournamentId }, select: { status: true } });
    if (t?.status === TournamentStatus.SYNCING) {
      throw new Error('모든 기기가 돌아올 때까지 기다려 주세요.');
    }

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
      case 'RESUME_TABLE':
        return this.dealer.resumeTable(tableId);
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
  async handleSeatListUpdated(payload: { tournamentId: string; state: any }) {
    this.broadcastToTournament(payload.tournamentId, 'renderSeatList', payload.state);

    // 좌석이 SYNCING 중에 전부 풀리면(T96) n이 0으로 떨어지는데, 그 변화는
    // 딜러 접속·접속해제 어느 쪽에서도 일어나지 않는다 — 접속 이벤트만
    // 기다리면 그 대회는 다음 부팅까지 영영 SYNCING에 머문다. `@OnEvent`
    // 핸들러의 거부는 아무도 처리하지 않으므로 여기서 삼킨다 — 로그는
    // `reportSync`의 체인이 이미 남긴다(M7), 여기서 또 찍지 않는다.
    await this.reportSync(payload.tournamentId).catch(() => { /* reportSync가 이미 로그로 남긴다 */ });
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
   * **알린 뒤 끊는다.** 닫힌 대회의 소켓은 받을 것도 보낼 것도 없다 —
   * 스냅샷이 지워져 밀어줄 프레임이 없고, 무엇을 눌러도 돌아오는 것은
   * 거절뿐이다. 열어 두면 게이트웨이가 죽은 방을 들고 있게 된다.
   *
   * **코드 1000(정상 종료)이라야 한다.** 단말의 `onclose`는 그 값만 정상으로
   * 보고 넘어간다(`DealerGameClient` · `SeatGameClient`). 다른 코드로 닫으면
   * 화면이 연결 끊김 배너를 그리는데, **대회가 끝난 것과 망이 끊긴 것은
   * 딜러에게 전혀 다른 사건**이라 그 배너가 종료 덮개와 겹쳐 뜬다.
   *
   * **순서가 요건이다.** 보내는 것이 먼저고 닫는 것이 나중이다. 뒤집히면
   * 단말은 왜 끊겼는지 모른 채 마지막 스냅샷을 그리고 있게 된다 — 고치기
   * 전의 그 상태다.
   */
  @OnEvent('TOURNAMENT_CLOSED')
  handleTournamentClosed(payload: { tournamentId: string; tableIds: string[]; status: string }) {
    // 닫힌 대회의 회선 기록을 버린다(T121). 계약 검사보다 앞이다 — 알림이 못 나가도 지운다.
    this.redis.linePause.clear(payload.tournamentId);
    this.lastDealerSeenAt.delete(payload.tournamentId);
    this.forcedAt.delete(payload.tournamentId);
    clearTimeout(this.graceTimers.get(payload.tournamentId));
    this.graceTimers.delete(payload.tournamentId);
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
      this.closeTable(tableId);
    }
  }

  /**
   * 세대가 오른 신원의 열린 소켓을 닫는다(T110). 테이블 방과 대회 방을 다 본다.
   * `close`가 던져도 나머지를 닫는다 — `closeTable`과 같은 이유다. 실제 정리는
   * 뒤이어 오는 `handleDisconnect`가 한다.
   */
  private closeWhere(match: (socket: any) => boolean, reason: string) {
    for (const map of [this.tableSessions, this.tournamentSessions]) {
      for (const sessions of map.values()) {
        for (const socket of sessions) {
          if (!match(socket)) continue;
          // 서버가 내보냈다는 표시(T121) — 마지막 딜러면 유예 없이 대회를 멈춘다.
          (socket as any).revokedByServer = true;
          try {
            socket.close(SESSION_REVOKED_CLOSE_CODE, reason);
          } catch {
            // 이미 닫힌 소켓.
          }
        }
      }
    }
  }

  @OnEvent('SEAT_TOKENS_REVOKED')
  handleSeatTokensRevoked(payload: { tournamentId: string; userIds: string[]; reason: string }) {
    const users = new Set(payload.userIds);
    this.closeWhere(
      (s) => s.role === SEAT_ROLE && s.tournamentId === payload.tournamentId && users.has(s.userId),
      payload.reason,
    );
  }

  @OnEvent('DEALER_SESSION_REVOKED')
  handleDealerSessionRevoked(payload: { tournamentId: string }) {
    this.closeWhere(
      (s) => s.role === Role.DEALER && s.tournamentId === payload.tournamentId,
      DEALER_REVOKED_REASON,
    );
  }

  /** 좌석은 세대, 딜러는 세션을 지금 DB와 대조한다. 낡으면 `ForbiddenException`. */
  private async assertIdentityCurrent(payload: WsIdentity): Promise<void> {
    if (payload.role === SEAT_ROLE) {
      await assertSeatTokenCurrent(this.prisma, {
        userId: payload.sub,
        tournamentId: payload.tournamentId,
        ver: payload.seatTokenVersion,
      });
    } else if (payload.role === Role.DEALER) {
      await this.dealer.assertDealerSessionValid({
        sub: payload.sub,
        tournamentId: payload.tournamentId!,
        tableId: payload.tableId!,
        tokenVersion: payload.tokenVersion!,
      });
    }
  }

  /**
   * 방에 넣은 뒤 신원을 한 번 더 본다(T110). 앞선 대조와 `addToMap` 사이에
   * 세대가 오르면 `SEAT_TOKENS_REVOKED`·`DEALER_SESSION_REVOKED`는 아직 방에 없는
   * 이 소켓을 놓친다. 틀리면 닫고 방에서 뺀다. 닫혔으면 `true`. 낡은 토큰
   * (`ForbiddenException`)만 4001이다 — 클라가 재연결을 멈추는 코드라, 일시적인
   * 오류에는 재시도되는 1008로 닫는다.
   */
  private async closeIfStale(client: any, payload: WsIdentity): Promise<boolean> {
    if (payload.role !== SEAT_ROLE && payload.role !== Role.DEALER) return false;
    try {
      await this.assertIdentityCurrent(payload);
      return false;
    } catch (e) {
      try {
        if (e instanceof ForbiddenException) client.close(SESSION_REVOKED_CLOSE_CODE, e.message);
        else client.close(1008, '인증 실패');
      } catch {
        // 이미 닫힌 소켓.
      }
      await this.handleDisconnect(client);
      return true;
    }
  }

  /**
   * 한 테이블 방의 소켓을 전부 정상 종료로 닫고 방을 버린다.
   *
   * **`close`가 던져도 나머지를 닫는다.** `broadcast`가 죽은 소켓 하나에
   * 루프를 멈추지 않게 만든 것과 같은 이유다 — 하나가 이미 끊겨 있다고 옆
   * 단말이 열린 채로 남으면, 그 태블릿만 끝난 대회를 그리고 있게 된다.
   */
  private closeTable(tableId: string) {
    // **이 테이블의 리바인 기록도 함께 버린다**(T101 잔여). 기록은 응답 ·
    // 마감 지난 읽기 · 새 프롬프트로만 지워지는데, 끝내 다시 안 붙은 사람의
    // 것은 그 셋 중 어느 것도 안 온다 — 대회가 닫혀도 프로세스 재시작까지
    // 남았다. 닫힌 테이블에는 재전송할 소켓 자체가 없으므로 여기가 끝이다.
    //
    // 키가 `${tableId}:${userId}`라 접두사로 고른다. `tableId`는 uuid여서
    // 콜론이 없고, 그래서 첫 콜론까지가 정확히 테이블이다.
    const prefix = `${tableId}:`;
    for (const key of this.pendingRebuyPrompts.keys()) {
      if (key.startsWith(prefix)) this.pendingRebuyPrompts.delete(key);
    }

    const sessions = this.tableSessions.get(tableId);
    if (!sessions) return;
    for (const socket of sessions) {
      try {
        // 이유 문자열은 단말이 읽지 않는다(코드 1000이면 `onclose`가 그대로
        // 넘어간다). 로그와 프록시가 읽는 자리라 남긴다.
        // 서버가 닫는 소켓이다 — 뒤따르는 끊김을 회선 탓으로 읽지 않는다(`handleDisconnect`).
        (socket as any).closedByServer = true;
        socket.close(1000, '대회가 종료되었습니다.');
      } catch {
        // 이미 닫힌 소켓. 아래에서 방째로 버리므로 따로 지울 것이 없다.
      }
    }
    this.tableSessions.delete(tableId);
  }

  @OnEvent('rebuy.request.sent')
  handleRebuyRequest(payload: { userId: string, tableId: string, deadline: number, userPoints: any, entryFee: number, tournamentName: string }) {
    const prompt = {
      deadline: payload.deadline,
      userPoints: payload.userPoints,
      entryFee: payload.entryFee,
      tournamentName: payload.tournamentName,
    };
    // 재접속 대비 적어 둔다. 새 프롬프트는 같은 키(테이블·사람)를 덮는다.
    // 세대는 기록에만 싣는다 — 와이어로 나가는 `prompt`에는 넣지 않는다(M2).
    this.pendingRebuyPrompts.set(
      this.rebuyPromptKey(payload.tableId, payload.userId),
      { ...prompt, generation: this.redis.outage.generation },
    );
    this.sendToTableUser(payload.tableId, payload.userId, 'REBUY_PROMPT', prompt);
  }

  @SubscribeMessage('REBUY_RESPONSE')
  handleRebuyResponse(@ConnectedSocket() client: any, @MessageBody() data: any) {
    // T110. 해제로 닫힌 소켓도 피어가 응답하거나 closeTimeout(30초)이 찰 때까지
    // 프레임이 계속 들어온다 — 닫히는 중이면 처리하지 않는다.
    if (client.readyState !== WebSocket.OPEN) return;

    // T100. 장애 중의 응답은 받아도 반영할 수 없다 — 칩을 넣는 첫 쓰기가 Redis다.
    // 누른 사람에게 이유를 돌려주고, 판은 딜러가 다시 열 때 새로 묻는다.
    if (!this.redis.outage.isUp()) return { event: 'error', data: SERVER_RECOVERING_MESSAGE };
    const parsed = RebuyResponseSchema.safeParse(data);
    // accept가 없으면 undefined가 그대로 흘러가 거절로 취급된다.
    // 거절과 잘못된 요청은 구분되어야 한다.
    if (!parsed.success) {
      return { event: 'error', data: '잘못된 리바인 응답입니다.' };
    }

    const userId = (client as any).userId;
    const tableId = (client as any).tableId;
    // 응답이 흘러갔다 — 이 사람의 기록은 더 이상 재전송할 이유가 없다.
    this.pendingRebuyPrompts.delete(this.rebuyPromptKey(tableId, userId));
    this.eventEmitter.emit(`rebuy_res_${userId}`, parsed.data.accept);
  }

}
