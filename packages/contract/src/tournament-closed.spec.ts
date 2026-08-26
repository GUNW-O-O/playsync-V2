import { TournamentClosedSchema } from './tournament-closed';

const VALID = {
  tournamentId: 'tour-1',
  status: 'FINISHED' as const,
  closedAt: 1_787_703_039_280,
};

describe('TournamentClosedSchema', () => {
  it('닫힌 대회의 봉투를 통과시킨다', () => {
    expect(TournamentClosedSchema.parse(VALID)).toEqual(VALID);
  });

  it('중단으로 닫힌 것도 같은 봉투다', () => {
    const aborted = { ...VALID, status: 'CANCELLED' as const };
    expect(TournamentClosedSchema.parse(aborted).status).toBe('CANCELLED');
  });

  /**
   * **살아 있는 상태로는 이 봉투를 못 만든다.** 이벤트 이름이 「닫혔다」인데
   * `ONGOING`이 실려 나가면 화면은 「끝났습니다」를 그리면서 대회는 돌고 있다.
   * 그 조합을 만들 길을 스키마에서 막는다.
   */
  it.each(['ONGOING', 'PENDING'])('%s는 닫힌 상태가 아니라 거부한다', (status) => {
    expect(() => TournamentClosedSchema.parse({ ...VALID, status })).toThrow();
  });

  /**
   * 아웃바운드라 `.strict()`가 아니다. 백엔드가 필드를 늘려도 조용히 스트립되는
   * 것이 이 계약의 그물이고, **그 사실을 여기서 한 번 태운다** — 태우는 자리가
   * 없으면 규칙이 문서로만 남는다(`WsGateway`의 `toWireState`가 그 자리다).
   */
  it('계약에 없는 필드는 조용히 제거한다', () => {
    const parsed = TournamentClosedSchema.parse({ ...VALID, storeOwnerId: 'store-1' });
    expect(parsed).not.toHaveProperty('storeOwnerId');
  });

  it('closedAt이 없으면 거부한다', () => {
    const { closedAt: _closedAt, ...without } = VALID;
    expect(() => TournamentClosedSchema.parse(without)).toThrow();
  });
});
