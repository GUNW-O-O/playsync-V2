import {
  currentRegistrationLevel,
  isRegistrationOpenAtLevel,
  isRegistrationOpenNow,
} from './registration';

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

/**
 * **휴식은 레벨이 아니다.** 구조에서 휴식 구간은 `lv === 99`인 원소인데,
 * 마감 판정은 같은 `lv`를 숫자로 비교한다 — 휴식에 들어가는 순간 어떤
 * 정상값에서도 `99 < rebuyUntil`이 거짓이라 등록이 닫히고, 그 마감은 단조라
 * **되돌아오지 않는다**(T63).
 *
 * 규정상 5레벨까지 리바인 가능한 대회에서 3레벨에 파산한 사람이 리바인 없이
 * 탈락한다 — `resolveWinners`가 `isRegistrationOpen`을 보고 팝업 자체를 안
 * 띄우기 때문이다.
 *
 * 판정에 쓰는 레벨을 여기서 만든다. 호출자마다 "휴식이면 직전 것"을 각자
 * 적으면 검사가 셋이 되고, 그중 하나만 고쳐지는 날이 온다.
 */
describe('currentRegistrationLevel', () => {
  const withBreak = [
    { lv: 1, sb: 100, ante: false, duration: 1 },
    { lv: 2, sb: 200, ante: false, duration: 1 },
    { lv: 99, sb: 200, ante: false, duration: 1 },
    { lv: 3, sb: 300, ante: false, duration: 1 },
  ];

  it('보통 레벨에서는 그 레벨이다', () => {
    expect(currentRegistrationLevel(withBreak, 1)).toBe(2);
  });

  it('휴식 중이면 직전 실제 레벨이다', () => {
    // 이 한 줄이 T63이다. 지금은 99가 나와 등록이 영구히 닫힌다.
    expect(currentRegistrationLevel(withBreak, 2)).toBe(2);
  });

  it('휴식이 끝나면 다시 그다음 레벨이다', () => {
    expect(currentRegistrationLevel(withBreak, 3)).toBe(3);
  });

  it('휴식이 연달아 있어도 실제 레벨까지 거슬러 간다', () => {
    const twoBreaks = [
      { lv: 1, sb: 100, ante: false, duration: 1 },
      { lv: 99, sb: 100, ante: false, duration: 1 },
      { lv: 99, sb: 100, ante: false, duration: 1 },
    ];

    expect(currentRegistrationLevel(twoBreaks, 2)).toBe(1);
  });

  it('구조가 휴식으로 시작하면 0이다', () => {
    // 지나온 레벨이 없다. 0은 어떤 `rebuyUntil`보다도 작아 등록이 열려 있다 —
    // 아직 아무 레벨도 지나지 않았으니 그것이 맞다.
    const leadingBreak = [
      { lv: 99, sb: 100, ante: false, duration: 1 },
      { lv: 1, sb: 100, ante: false, duration: 1 },
    ];

    expect(currentRegistrationLevel(leadingBreak, 0)).toBe(0);
  });

  it('인덱스가 구조 밖이면 마지막 실제 레벨로 접는다', () => {
    // 0을 주면 **등록이 영영 열린다** — 0은 어떤 `rebuyUntil`보다 작다.
    // 돈이 걸린 문지기라 모르는 값은 닫히는 쪽으로 접는 편이 맞고,
    // `getCurrentBlindLevel`도 경과가 구조를 넘으면 마지막으로 클램프한다.
    expect(currentRegistrationLevel(withBreak, 99)).toBe(3);
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

  it('휴식 중에도 마감되지 않는다', () => {
    // 구조: 1분씩 [lv1][lv2][휴식][lv3], rebuyUntil 3.
    // 150초 경과면 휴식 구간이다. 휴식의 `lv`(99)로 재면 즉시 마감이고,
    // 그 마감은 단조라 되돌아오지 않는다.
    const withBreak = [
      { lv: 1, sb: 100, ante: false, duration: 1 },
      { lv: 2, sb: 200, ante: false, duration: 1 },
      { lv: 99, sb: 200, ante: false, duration: 1 },
      { lv: 3, sb: 300, ante: false, duration: 1 },
    ];

    expect(
      isRegistrationOpenNow({
        isRegistrationOpen: true,
        rebuyUntil: 3,
        startedAt: new Date(Date.now() - 150_000),
        pausedMs: 0,
        blindStructure: { structure: withBreak },
      }),
    ).toBe(true);
  });

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
