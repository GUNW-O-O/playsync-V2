import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { WsTicketResponse } from '@playsync/contract';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { SEAT_ROLE } from 'src/auth/seat-role';
import { DealerService } from 'src/dealer/dealer.service';
import { assertSeatTokenCurrent } from 'src/entry/seat-token';
import { PrismaService } from 'src/prisma/prisma.service';
import { WsTicketService } from './ws-ticket.service';

/**
 * WS 핸드셰이크용 티켓을 발급한다.
 *
 * 이 경로는 **Next의 서버 쪽만 부른다**(`/api/ws-ticket` route handler).
 * 브라우저 JS는 액세스 토큰을 갖고 있지 않으므로 여기를 직접 부를 수 없다.
 */
@Controller('ws')
export class WsTicketController {
  constructor(
    private readonly tickets: WsTicketService,
    private readonly dealer: DealerService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('ticket')
  async issue(@Req() req: any): Promise<WsTicketResponse> {
    // JwtStrategy가 역할마다 다른 모양을 준다 — 딜러는 `id`, 그 외는 `userId`다.
    // 잘못 읽으면 sub가 undefined인 티켓이 나가고, 게이트웨이의 좌석 대조가
    // 아무와도 맞지 않아 조용히 거부된다.
    if (req.user.role === Role.DEALER) {
      // 발급 시점에 세션을 대조한다. 상점이 내보낸 딜러는 새 연결도 재연결도
      // 여기서 막힌다 — 붙어 있는 소켓은 내보내기가 닫는다(`DEALER_SESSION_REVOKED`, T110).
      await this.dealer.assertDealerSessionValid({
        sub: req.user.id,
        tournamentId: req.user.tournamentId,
        tableId: req.user.tableId,
        tokenVersion: req.user.tokenVersion,
      });

      return {
        ticket: await this.tickets.issue({
          sub: req.user.id,
          role: Role.DEALER,
          tournamentId: req.user.tournamentId,
          tableId: req.user.tableId,
          tokenVersion: req.user.tokenVersion,
        }),
      };
    }

    // T110. 좌석 토큰은 세대를 대조한다. 입장·해제가 세대를 올리면 옛 토큰은
    // 여기서 막히고, 이미 붙어 있던 소켓은 게이트웨이가 닫는다.
    if (req.user.role === SEAT_ROLE) {
      await assertSeatTokenCurrent(this.prisma, {
        userId: req.user.userId,
        tournamentId: req.user.tournamentId,
        ver: req.user.ver,
      });
      return {
        ticket: await this.tickets.issue({
          sub: req.user.userId,
          role: SEAT_ROLE,
          tournamentId: req.user.tournamentId,
          seatTokenVersion: req.user.ver,
        }),
      };
    }

    return {
      ticket: await this.tickets.issue({ sub: req.user.userId, role: req.user.role }),
    };
  }
}
