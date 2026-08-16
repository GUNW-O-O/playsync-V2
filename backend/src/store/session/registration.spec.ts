import { isRegistrationOpenAtLevel, isRegistrationOpenNow } from './registration';

/**
 * 마감 규칙 그 자체. 인프라가 없어도 되는 순수 함수라 단위 계층이다.
 *
 * 통합 스펙(`payment.service.int-spec.ts`)이 같은 규칙을 결제 경로로 한 번 더
 * 본다. 나누는 이유는 그쪽이 **Redis 캐시가 있는 평소 경로**를 보고, 여기는
 * 캐시가 없을 때 쓰이는 계산 자체를 보기 때문이다 — 통합 쪽만 있으면 이
 * 함수의 분기 절반이 결제의 다른 검사에 가려진다.
 */
describe('isRegistrationOpenAtLevel', () => {
  it('마감 레벨 전이면 열려 있다', () => {
    expect(isRegistrationOpenAtLevel(true, 1, 2)).toBe(true);
  });

  it('마감 레벨에 닿으면 닫힌다', () => {
    expect(isRegistrationOpenAtLevel(true, 2, 2)).toBe(false);
  });

  /**
   * `>=`이지 `===`가 아니다. 레벨은 시작 시각과 현재 시각으로 매번 다시
   * 계산되므로 한 번에 여러 칸 뛴다(재기동, 폴링 지연, 정지 시간 보정).
   * 정확히 일치할 때만 닫으면 마감 레벨을 밟지 못하고 지나간 대회는 등록이
   * 영영 열린 채로 남는다.
   */
  it('마감 레벨을 건너뛰어도 닫힌다', () => {
    expect(isRegistrationOpenAtLevel(true, 5, 2)).toBe(false);
  });

  it('상점이 손으로 닫았으면 레벨과 무관하게 닫힌 것이다', () => {
    expect(isRegistrationOpenAtLevel(false, 1, 2)).toBe(false);
  });
});

describe('isRegistrationOpenNow', () => {
  /** 레벨 하나가 1분. `lv` 값이 `rebuyUntil`과 비교되는 값이다. */
  const structure = [
    { lv: 1, sb: 100, ante: false, duration: 1 },
    { lv: 2, sb: 200, ante: false, duration: 1 },
    { lv: 3, sb: 300, ante: false, duration: 1 },
  ];

  function tournament(over: Partial<{
    isRegistrationOpen: boolean;
    rebuyUntil: number;
    startedAt: Date | null;
    pausedMs: number;
  }> = {}) {
    return {
      isRegistrationOpen: true,
      rebuyUntil: 2,
      startedAt: new Date(Date.now() - 90_000),
      pausedMs: 0,
      blindStructure: { structure },
      ...over,
    };
  }

  it('경과 시간으로 레벨을 구해 판정한다', () => {
    // 90초 경과 → 레벨 2. rebuyUntil 2면 마감이다.
    expect(isRegistrationOpenNow(tournament())).toBe(false);
    // 30초 경과 → 레벨 1. 아직 열려 있다.
    expect(isRegistrationOpenNow(tournament({ startedAt: new Date(Date.now() - 30_000) })))
      .toBe(true);
  });

  /**
   * 정지 시간은 진행 시간이 아니다. 블라인드 시계가 이미 같은 보정을 하므로
   * (T31), 여기서 빼먹으면 장애를 겪은 대회에서만 등록이 일찍 닫혀 전광판과
   * 결제가 서로 다른 레벨을 본다.
   */
  it('정지 시간만큼 기준점을 민다', () => {
    expect(isRegistrationOpenNow(tournament({ pausedMs: 60_000 }))).toBe(true);
  });

  /**
   * **시작 전 대회에는 레벨이 없다.** 기준점이 없는데 0을 기준으로 삼으면
   * 경과가 수십 년이 되어 마지막 레벨이 나오고, 사전 등록이 통째로 막힌다.
   * 이 분기는 결제 경로에서는 그쪽의 조기 반환에 가려 보이지 않는다.
   */
  it('시작 전이면 상점 스위치만 본다', () => {
    expect(isRegistrationOpenNow(tournament({ startedAt: null, rebuyUntil: 1 }))).toBe(true);
    expect(
      isRegistrationOpenNow(tournament({ startedAt: null, isRegistrationOpen: false })),
    ).toBe(false);
  });
});
