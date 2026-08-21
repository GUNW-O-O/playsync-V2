import { TournamentStatus } from '@prisma/client';
import { PaymentService } from 'src/payment/payment.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionService } from './session.service';
import { isClosedTournament } from './tournament-status';

/**
 * 살아 있는 대회를 조회에서 빠뜨리지 않는지(T71 9-3).
 *
 * 이 리포는 같은 함정에 이미 한 번 걸렸다 — "상태를 나열해서 살아있는 것만
 * 고르면, 나중에 상태가 하나 늘 때 조용히 빠진다"(`user.service.ts`의
 * `getMyParticipations` 주석). `SYNCING`이 실제로 그랬고, 그 값이 붙는 순간
 * 대회가 상점 목록과 딜러 조회에서 통째로 사라졌다. T71이 그 값을 지웠지만
 * **나열이 여집합으로 바뀌지 않으면 다음 상태에서 같은 일이 또 난다** —
 * 이 검사가 지키는 것은 값 하나가 아니라 그 규칙이다.
 *
 * **필터의 모양이 아니라 통과하는 상태를 단언한다.** `in`이든 `notIn`이든
 * 판정이 `isClosedTournament`와 일치하면 된다 — 그래야 나중에 표현을 바꿔도
 * 이 검사가 지키는 성질은 그대로다.
 */
describe('닫히지 않은 대회는 조회에서 빠지지 않는다', () => {
  const ALL = Object.values(TournamentStatus);

  /** `where.status` 절이 이 상태를 통과시키는가. */
  function admits(clause: unknown, status: TournamentStatus): boolean {
    if (clause === undefined || clause === null) return true;
    if (typeof clause === 'string') return clause === status;
    const filter = clause as { in?: TournamentStatus[]; notIn?: TournamentStatus[] };
    if (filter.in) return filter.in.includes(status);
    if (filter.notIn) return !filter.notIn.includes(status);
    throw new Error(`알 수 없는 status 절: ${JSON.stringify(clause)}`);
  }

  function expectMatchesClosedRule(clause: unknown, where: string) {
    const admitted = ALL.filter(s => admits(clause, s)).sort();
    const alive = ALL.filter(s => !isClosedTournament(s)).sort();
    expect(`${where}: ${admitted.join(',')}`).toBe(`${where}: ${alive.join(',')}`);
  }

  it('상점의 참가 가능 대회 목록', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PaymentService(
      undefined as never,
      undefined as never,
      { tournament: { findMany } } as unknown as PrismaService,
      undefined as never,
    );

    await service.getStoreAvailableSessions('store-1');

    expectMatchesClosedRule(findMany.mock.calls[0][0].where.status, 'getStoreAvailableSessions');
  });

  it('딜러가 여는 대회와 테이블 조회', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const service = new SessionService(
      { tournament: { findUnique } } as unknown as PrismaService,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await service.getGameSessionWithTables('trn-1');

    expectMatchesClosedRule(findUnique.mock.calls[0][0].where.status, 'getGameSessionWithTables');
  });
});
