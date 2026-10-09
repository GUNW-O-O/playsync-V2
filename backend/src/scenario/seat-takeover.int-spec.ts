import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SEAT_RELEASED_REASON, SEAT_REVOKED_REASON } from '@playsync/contract';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { WsGateway } from 'src/ws/ws.gateway';
import { WsTicketController } from 'src/ws/ws-ticket.controller';
import { WsTicketService } from 'src/ws/ws-ticket.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RecoveryService } from 'src/recovery/recovery.service';
import { checkInvariants, forceClose, Harness, SCENARIO, setupTournament } from './harness';

// 재집계 보류 창(T117)은 SyncQueue 단위 검사가 맡는다. 통합 검사는 `connect` 직후 결과를
// 읽으므로 게이트웨이를 보류 0으로 세운다 — `new WsGateway`보다 먼저 정해져야 한다.
process.env.SYNC_RECOUNT_HOLD_MS = '0';

/**
 * 좌석 탈취와 대응(T110) — 입장 · 티켓 · 소켓 · 상점 해제가 한 줄로 이어지는지.
 *
 * 부품은 각자 옳다(입장은 세대를 올리고, 게이트웨이는 이벤트에 소켓을 닫는다).
 * 이 시나리오가 보는 것은 **이음매**다 — 서비스가 낸 이벤트가 진짜
 * `EventEmitter2`를 타고 게이트웨이 핸들러에 닿는가, 닫힌 좌석의 옛 토큰이
 * 티켓 발급에서 막히는가. 소켓만 가짜다(전송 계층).
 */
describe('시나리오 — 좌석 탈취와 상점의 대응', () => {
  const VICTIM = 'victim';
  const OTHER = 'other';

  let h: Harness;
  let gateway: WsGateway;
  let ticketController: WsTicketController;
  let jwt: JwtService;

  function makeClient() {
    const client: any = {
      readyState: 1,
      close: jest.fn(),
      send: jest.fn(),
      on: jest.fn(),
    };
    return client;
  }

  async function playerOtp(userId: string) {
    return (await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId } },
      omit: { playerOtp: false },
    })).playerOtp;
  }

  async function enter(otp: string) {
    const { accessToken } = await h.entry.enterSeat(h.tournamentId, {
      otp, tableId: h.tableId, seatIndex: 0,
    });
    return accessToken;
  }

  /** `JwtStrategy.validate`가 좌석 토큰에 주는 모양 그대로 컨트롤러에 넘긴다. */
  async function requestTicket(token: string) {
    const p = jwt.verify(token) as {
      sub: string; tournamentId: string; tableId: string; seatIndex: number; ver: number;
    };
    return ticketController.issue({
      user: {
        userId: p.sub, tournamentId: p.tournamentId, tableId: p.tableId,
        seatIndex: p.seatIndex, ver: p.ver, role: SEAT_ROLE,
      },
    });
  }

  async function connect(token: string) {
    const { ticket } = await requestTicket(token);
    const client = makeClient();
    await gateway.handleConnection(client, {
      url: `/playsync?tableId=${h.tableId}&ticket=${ticket}`,
      headers: { host: 'localhost', origin: 'http://localhost:3000' },
    });
    return client;
  }

  function closedWith(client: { close: jest.Mock }) {
    return client.close.mock.calls.map(c => `${c[0]}:${c[1]}`);
  }

  beforeAll(async () => {
    h = await setupTournament([VICTIM, OTHER]);
    jwt = new JwtService({ secret: 'scenario-secret' });
    const prismaService = h.prisma as unknown as PrismaService;
    const tickets = new WsTicketService(h.redis);
    gateway = new WsGateway(
      h.dealer, h.playsync, h.redisService, tickets, h.emitter, prismaService,
      new RecoveryService(prismaService, h.redisService),
    );
    // Nest는 `@OnEvent`를 이렇게 같은 에미터에 건다. 서비스가 낸 이벤트가
    // 진짜 에미터를 거쳐 핸들러에 닿게 하는 것이 요점이라 직접 배선한다.
    h.emitter.on('SEAT_TOKENS_REVOKED', p => gateway.handleSeatTokensRevoked(p));
    ticketController = new WsTicketController(tickets, h.dealer, prismaService);
  });

  afterAll(async () => {
    await h.close();
    await forceClose();
  });

  it('입장 → 재입장(탈취) → 상점 해제 → 새 OTP 재입장', async () => {
    const victimUser = VICTIM;
    const originalOtp = await playerOtp(victimUser);

    // 1. 피해자가 입장하고 붙는다.
    const victimToken = await enter(originalOtp);
    const vSocket = await connect(victimToken);
    expect(`1. 피해자 소켓 닫힘 ${closedWith(vSocket)}`).toBe('1. 피해자 소켓 닫힘 ');
    await checkInvariants(h, '1. 입장 직후', SCENARIO.startStack * 2);

    // 2. 공격자가 같은 OTP로 다시 입장한다 — 피해자 소켓이 끊긴다.
    const attackerToken = await enter(originalOtp);
    expect(`2. 피해자 소켓 ${closedWith(vSocket)}`)
      .toBe(`2. 피해자 소켓 4001:${SEAT_REVOKED_REASON}`);

    // 옛 토큰은 티켓도 못 받는다.
    await expect(requestTicket(victimToken)).rejects.toBeInstanceOf(ForbiddenException);

    // 3. 공격자가 붙는다.
    const aSocket = await connect(attackerToken);
    expect(`3. 공격자 소켓 ${closedWith(aSocket)}`).toBe('3. 공격자 소켓 ');
    await checkInvariants(h, '3. 탈취 후', SCENARIO.startStack * 2);

    // 4. 상점이 해제하며 OTP를 바꾼다 — 공격자 소켓이 끊긴다.
    await h.session.releaseSeats(
      h.tournamentId, h.tableId, [{ seatIndex: 0, userId: victimUser }], SCENARIO.owner, true,
    );
    expect(`4. 공격자 소켓 ${closedWith(aSocket)}`)
      .toBe(`4. 공격자 소켓 4001:${SEAT_RELEASED_REASON}`);
    await checkInvariants(h, '4. 해제 후', SCENARIO.startStack);

    // 5. 공격자의 토큰은 티켓이 403, 옛 OTP는 입장이 401이다.
    await expect(requestTicket(attackerToken)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(enter(originalOtp)).rejects.toBeInstanceOf(UnauthorizedException);

    // 6. 피해자가 새 OTP로 돌아온다. 칩은 해제 전과 같다(장부 보존).
    const newOtp = await playerOtp(victimUser);
    expect(`6. OTP 교체 ${newOtp !== originalOtp}`).toBe('6. OTP 교체 true');
    const returned = await enter(newOtp);
    const rSocket = await connect(returned);
    expect(`6. 복귀 소켓 ${closedWith(rSocket)}`).toBe('6. 복귀 소켓 ');
    const ledger = await h.prisma.tournamentParticipation.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId: h.tournamentId, userId: victimUser } },
    });
    expect(`6. 장부 ${ledger.currentStack}`).toBe(`6. 장부 ${SCENARIO.startStack}`);
    await checkInvariants(h, '6. 복귀 후', SCENARIO.startStack * 2);
  });
});
