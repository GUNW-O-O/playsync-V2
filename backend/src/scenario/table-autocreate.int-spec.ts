import { Harness, setupTournament } from './harness';

/**
 * 테이블은 착석으로 늘어나지 않는다.
 *
 * 예전에는 좌석 점유 수가 정확히 7이 되는 순간 `createTable`이 불렸다
 * (`payment.service.ts`의 `cnt === 7`). 카운트 비교라 엣지 트리거였고,
 * 탈락으로 좌석이 비었다가 리바인·늦은 등록으로 다시 차면 7을 다시 넘어
 * 빈 테이블이 계속 생겼다. `createTable`은 이미 빈 테이블이 있는지도 보지
 * 않았다.
 *
 * 테이블을 여는 것은 딜러를 배치하고 칩을 세팅하는 물리적 행위라 시스템이
 * 대신 결정할 근거가 없다. 이제 상점 콘솔이 만든다.
 */
describe('시나리오 — 테이블 자동 생성 제거', () => {
  let h: Harness;
  const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

  beforeAll(async () => {
    h = await setupTournament(PLAYERS);
  });

  afterAll(async () => {
    await h.close();
  });

  it('일곱 명이 앉아도 테이블은 하나다', async () => {
    const count = await h.prisma.table.count({
      where: { tournamentId: h.tournamentId },
    });

    expect(`테이블 수 ${count}`).toBe('테이블 수 1');
  });
});
