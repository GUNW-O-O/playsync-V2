import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
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
  /**
   * 아래 동작 테스트들은 `new WsTicketController(...)`로 클래스를 직접
   * 인스턴스화한다 — `@UseGuards(JwtAuthGuard)`가 지워져도 빨개지지 않는다.
   * `JwtAuthGuard`는 `AuthGuard('jwt')`(passport)를 상속해 `canActivate`를
   * 직접 부르려면 passport 전략 등록이 필요하다 — `session.controller.spec.ts`가
   * 쓰는 `RolesGuard(new Reflector())` 직접 실행 방식은 여기 그대로 옮길 수
   * 없다. 대신 Nest의 `@UseGuards`가 실제로 남기는 리플렉션 메타데이터
   * (`GUARDS_METADATA` = `'__guards__'`)를 읽어, 데코레이터가 `issue`
   * 핸들러에 실제로 붙어 있는지를 확인한다.
   */
  it('issue 핸들러에 JwtAuthGuard가 붙어 있다', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WsTicketController.prototype.issue);

    expect(guards).toContain(JwtAuthGuard);
  });

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
