import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { DealerService } from 'src/dealer/dealer.service';
import { WsTicketController } from './ws-ticket.controller';
import { WsTicketService } from './ws-ticket.service';

/**
 * 전략(JwtStrategy)과 컨트롤러 사이의 이음매.
 *
 * `JwtStrategy.validate`가 역할마다 다른 모양을 준다 — 딜러는 `id`, 그 외는
 * `userId`다. 컨트롤러가 이걸 헷갈리면 신원이 `undefined`인 티켓이 발급되고,
 * 게이트웨이의 좌석 대조가 아무와도 맞지 않아 조용히 거부된다. 이 이음매를
 * 지나는 테스트가 없으면 한 줄 실수가 전 스위트 초록으로 넘어간다.
 */
describe('WsTicketController', () => {
  let tickets: { issue: jest.Mock };
  let dealer: { assertDealerSessionValid: jest.Mock };
  let controller: WsTicketController;

  beforeEach(() => {
    tickets = { issue: jest.fn().mockResolvedValue('tkt-1') };
    dealer = { assertDealerSessionValid: jest.fn().mockResolvedValue({}) };
    controller = new WsTicketController(
      tickets as unknown as WsTicketService,
      dealer as unknown as DealerService,
    );
  });

  it('플레이어의 신원은 userId에서 온다', async () => {
    // 딜러 분기와 같은 `id`를 읽으면 sub가 undefined가 된다.
    await controller.issue({ user: { userId: 'alice', nickname: 'alice', role: Role.USER } });

    expect(tickets.issue).toHaveBeenCalledWith({ sub: 'alice', role: Role.USER });
  });

  it('딜러의 신원은 id에서 오고 대회·테이블이 함께 실린다', async () => {
    await controller.issue({
      user: {
        id: 'dealer-session-1',
        tournamentId: 'trnmt-1',
        tableId: 'tbl-7',
        tokenVersion: 3,
        role: Role.DEALER,
      },
    });

    expect(tickets.issue).toHaveBeenCalledWith({
      sub: 'dealer-session-1',
      role: Role.DEALER,
      tournamentId: 'trnmt-1',
      tableId: 'tbl-7',
    });
  });

  it('딜러는 세션 대조를 통과해야 티켓을 받는다', async () => {
    await controller.issue({
      user: {
        id: 'dealer-session-1',
        tournamentId: 'trnmt-1',
        tableId: 'tbl-7',
        tokenVersion: 3,
        role: Role.DEALER,
      },
    });

    expect(dealer.assertDealerSessionValid).toHaveBeenCalledWith({
      sub: 'dealer-session-1',
      tournamentId: 'trnmt-1',
      tableId: 'tbl-7',
      tokenVersion: 3,
    });
  });

  it('폐기된 딜러 세션이면 티켓을 만들지 않는다', async () => {
    // 상점이 내보낸 딜러가 여기서 막히지 않으면 "내보내기"가 재연결을 못 막는다.
    dealer.assertDealerSessionValid.mockRejectedValue(new ForbiddenException('만료된 딜러 세션입니다.'));

    await expect(
      controller.issue({
        user: {
          id: 'dealer-session-1',
          tournamentId: 'trnmt-1',
          tableId: 'tbl-7',
          tokenVersion: 3,
          role: Role.DEALER,
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(tickets.issue).not.toHaveBeenCalled();
  });

  it('플레이어에게는 딜러 세션 대조를 하지 않는다', async () => {
    await controller.issue({ user: { userId: 'alice', nickname: 'alice', role: Role.USER } });

    expect(dealer.assertDealerSessionValid).not.toHaveBeenCalled();
  });
});
