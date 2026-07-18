import { DealerActionSchema, RebuyResponseSchema } from "./dealer-action";

describe("DealerActionSchema", () => {
  describe("허용", () => {
    it("START_PRE_FLOP은 추가 필드가 없다", () => {
      expect(DealerActionSchema.parse({ action: "START_PRE_FLOP" })).toEqual({
        action: "START_PRE_FLOP",
      });
    });

    it("RESOLVE_WINNERS는 승자 목록을 받는다", () => {
      // 카드는 실물이므로 승자는 계산되지 않고 딜러가 입력한다.
      // 목록의 순서가 곧 순위다.
      const input = { action: "RESOLVE_WINNERS", winnerUserIds: ["alice", "bob"] };
      expect(DealerActionSchema.parse(input)).toEqual(input);
    });

    it.each(["DEALER_FOLD", "DEALER_KICK"])("%s는 대상 유저를 받는다", (action) => {
      const input = { action, targetUserId: "alice" };
      expect(DealerActionSchema.parse(input)).toEqual(input);
    });
  });

  describe("거부", () => {
    it("모르는 액션을 거부한다", () => {
      // 지금은 switch가 아무 case에도 안 걸리면 updatedState가 undefined인 채로
      // 테이블 전원에게 브로드캐스트된다.
      expect(DealerActionSchema.safeParse({ action: "DROP_TABLE" }).success).toBe(false);
    });

    it("플레이어 액션을 딜러 경로로 보낼 수 없다", () => {
      expect(DealerActionSchema.safeParse({ action: "FOLD" }).success).toBe(false);
    });

    it("빈 승자 목록을 거부한다", () => {
      expect(
        DealerActionSchema.safeParse({ action: "RESOLVE_WINNERS", winnerUserIds: [] }).success,
      ).toBe(false);
    });

    it("대상 유저 없는 킥을 거부한다", () => {
      expect(DealerActionSchema.safeParse({ action: "DEALER_KICK" }).success).toBe(false);
    });

    it("빈 문자열 대상을 거부한다", () => {
      expect(
        DealerActionSchema.safeParse({ action: "DEALER_KICK", targetUserId: "" }).success,
      ).toBe(false);
    });

    it("모르는 키가 섞이면 거부한다", () => {
      expect(
        DealerActionSchema.safeParse({
          action: "START_PRE_FLOP",
          token: "ey...",
          tableId: "table-1",
        }).success,
      ).toBe(false);
    });
  });
});

describe("RebuyResponseSchema", () => {
  it("accept를 받는다", () => {
    expect(RebuyResponseSchema.parse({ accept: true })).toEqual({ accept: true });
  });

  it.each([{}, { accept: "yes" }, { accept: 1 }, { accept: true, extra: 1 }])(
    "%p을 거부한다",
    (input) => {
      // accept가 없으면 undefined가 그대로 이벤트로 흘러가 falsy로 취급된다.
      // 거절인지 잘못된 요청인지 구분되지 않는다.
      expect(RebuyResponseSchema.safeParse(input).success).toBe(false);
    },
  );
});
