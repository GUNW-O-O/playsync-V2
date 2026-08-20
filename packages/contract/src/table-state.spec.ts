import {
  GamePhase,
  RenderGameEventSchema,
  TableStateSchema,
} from "./table-state";

/** 자리에 앉은 플레이어 하나. 테스트마다 필요한 칸만 덮어쓴다. */
function player(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    nickname: "alice",
    seatIndex: 0,
    stack: 9800,
    bet: 200,
    hasFolded: false,
    hasChecked: false,
    isAllIn: false,
    totalContributed: 200,
    ...overrides,
  };
}

/** 프리플랍 직후의 정상 스냅샷. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    phase: GamePhase.PRE_FLOP,
    players: [player(), player({ id: "user-2", nickname: "bob", seatIndex: 1 })],
    buttonUser: 0,
    currentTurnSeatIndex: 1,
    pot: 300,
    sidePots: [],
    currentBet: 200,
    smallBlind: 100,
    ante: 0,
    tournamentId: "tournament-1",
    ...overrides,
  };
}

describe("TableStateSchema", () => {
  describe("통과", () => {
    it("정상 스냅샷을 그대로 돌려준다", () => {
      const input = snapshot();
      expect(TableStateSchema.parse(input)).toEqual(input);
    });

    it("빈 좌석은 null로 남는다", () => {
      // 좌석 배열의 인덱스가 곧 자리 번호라 빈 자리를 걸러내면 안 된다.
      const input = snapshot({ players: [null, player({ seatIndex: 1 })] });
      expect(TableStateSchema.parse(input).players[0]).toBeNull();
    });

    it("사이드팟과 자격자 목록을 통과시킨다", () => {
      const sidePots = [{ amount: 500, relevantPlayerIds: ["user-1", "user-2"] }];
      expect(TableStateSchema.parse(snapshot({ sidePots })).sidePots).toEqual(sidePots);
    });

    it("actionDeadline은 없어도 되고 있으면 통과한다", () => {
      expect(TableStateSchema.parse(snapshot()).actionDeadline).toBeUndefined();
      expect(TableStateSchema.parse(snapshot({ actionDeadline: 1700000000000 })).actionDeadline).toBe(
        1700000000000,
      );
    });

    it.each(["RETRYING", "FAILED"])("dbSyncStatus %s는 클라가 봐야 하므로 남는다", (status) => {
      // 체크포인트 실패는 딜러만이 아니라 테이블 전원이 알아야 한다.
      // 재접속한 단말도 같은 것을 보도록 스냅샷 필드로 설계돼 있다.
      expect(TableStateSchema.parse(snapshot({ dbSyncStatus: status })).dbSyncStatus).toBe(status);
    });
  });

  describe("스트립", () => {
    it("timerEpoch를 지운다", () => {
      // 타이머 세대는 잡 폐기 판정을 위한 서버 내부 값이다. 클라가 쓸 일이
      // 없는데도 지금은 renderGame에 그대로 실려 나간다.
      const parsed = TableStateSchema.parse(snapshot({ timerEpoch: 7 }));
      expect(parsed).not.toHaveProperty("timerEpoch");
    });

    it("players의 tableId를 지운다", () => {
      // 좌석마다 같은 값이 반복된다. 테이블 스냅샷 자체가 이미 그 테이블이다.
      const parsed = TableStateSchema.parse(
        snapshot({ players: [player({ tableId: "table-1" })] }),
      );
      expect(parsed.players[0]).not.toHaveProperty("tableId");
    });

    it("스키마에 없는 필드는 조용히 사라진다", () => {
      // 아웃바운드의 요점이다 — 백엔드에 필드를 추가해도 자동으로 새지 않는다.
      const parsed = TableStateSchema.parse(snapshot({ dealerOtp: 1234 }));
      expect(parsed).not.toHaveProperty("dealerOtp");
    });
  });

  describe("거부", () => {
    it("모르는 phase를 거부한다", () => {
      expect(TableStateSchema.safeParse(snapshot({ phase: 99 })).success).toBe(false);
    });

    it("모르는 dbSyncStatus를 거부한다", () => {
      expect(TableStateSchema.safeParse(snapshot({ dbSyncStatus: "OK" })).success).toBe(false);
    });

    it("칩이 소수면 거부한다", () => {
      // 칩은 정수다. 소수가 통과하면 사이드팟 분배에서 1칩이 증발한다.
      expect(TableStateSchema.safeParse(snapshot({ pot: 300.5 })).success).toBe(false);
    });

    it("음수 스택을 거부한다", () => {
      const input = snapshot({ players: [player({ stack: -1 })] });
      expect(TableStateSchema.safeParse(input).success).toBe(false);
    });

    it("좌석 배열이 없으면 거부한다", () => {
      const { players: _players, ...withoutPlayers } = snapshot();
      expect(TableStateSchema.safeParse(withoutPlayers).success).toBe(false);
    });
  });
});

describe("RenderGameEventSchema", () => {
  it("renderGame 봉투로 감싼다", () => {
    const input = { event: "renderGame", data: snapshot() };
    expect(RenderGameEventSchema.parse(input)).toEqual(input);
  });

  it("다른 이벤트 이름을 거부한다", () => {
    // renderSeatList와 REBUY_PROMPT는 페이로드가 다르다. 봉투만 보고
    // 갈라내지 못하면 클라가 엉뚱한 스키마로 파싱한다.
    expect(
      RenderGameEventSchema.safeParse({ event: "renderSeatList", data: snapshot() }).success,
    ).toBe(false);
  });
});
