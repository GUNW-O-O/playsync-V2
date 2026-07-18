import { PLAYER_ACTIONS, PlayerActionSchema, PlayerActionType, PlayerActionTypeSchema } from "./action";

/**
 * 인바운드 경계의 계약.
 *
 * 여기서 통과한 값만 게임 엔진에 도달한다. 화이트리스트를 배열로 손수 관리하면
 * 액션이 늘어날 때 갱신을 잊는 순간 다시 뚫리므로, 스키마 자체가 화이트리스트가
 * 되도록 정의한다.
 */
describe("PlayerActionSchema", () => {
  describe("허용", () => {
    it.each(["CHECK", "CALL", "FOLD"])("%s를 받는다", (action) => {
      expect(PlayerActionSchema.parse({ action })).toEqual({ action });
    });

    it("RAISE는 금액과 함께 받는다", () => {
      expect(PlayerActionSchema.parse({ action: "RAISE", amount: 1000 })).toEqual({
        action: "RAISE",
        amount: 1000,
      });
    });
  });

  describe("내부 전용 액션 거부", () => {
    // ActionType이 숫자 enum이던 시절, 클라가 보낸 4는 TIME_OUT이었다.
    // 자기 턴에 TIME_OUT을 보내면 아무 상태도 바꾸지 않은 채 턴만 넘어가
    // hasChecked가 false로 남고, 라운드가 영영 끝나지 않았다.
    it.each(["TIME_OUT", "DEALER_KICK", "DEALER_FOLD"])(
      "%s는 클라이언트가 보낼 수 없다",
      (action) => {
        expect(PlayerActionSchema.safeParse({ action }).success).toBe(false);
      },
    );

    it("내부 전용 액션은 화이트리스트에 없다", () => {
      // 액션이 추가될 때 이 배열을 갱신하지 않으면 스키마 파싱이 먼저 깨진다.
      expect(PLAYER_ACTIONS).toEqual(["CHECK", "CALL", "FOLD", "RAISE"]);
    });
  });

  describe("모르는 키 거부", () => {
    it("서버가 읽지 않는 키가 섞이면 거부한다", () => {
      // 프론트는 매 액션마다 token과 tableId를 실어 보냈지만 서버는 둘 다
      // 읽지 않는다(핸드셰이크에서 이미 검증했다). 스키마가 이걸 드러낸다.
      const result = PlayerActionSchema.safeParse({
        action: "FOLD",
        token: "ey...",
        tableId: "table-1",
      });

      expect(result.success).toBe(false);
    });

    it("RAISE가 아닌 액션에 금액을 붙일 수 없다", () => {
      expect(PlayerActionSchema.safeParse({ action: "FOLD", amount: 1000 }).success).toBe(
        false,
      );
    });
  });

  describe("RAISE 금액", () => {
    it("금액이 없으면 거부한다", () => {
      expect(PlayerActionSchema.safeParse({ action: "RAISE" }).success).toBe(false);
    });

    it.each([0, -1, 1.5, NaN, Infinity])("%p을 거부한다", (amount) => {
      expect(PlayerActionSchema.safeParse({ action: "RAISE", amount }).success).toBe(false);
    });

    it("문자열 금액을 숫자로 바꿔주지 않는다", () => {
      // 경계에서 조용히 강제 변환하면, 어떤 값이 들어왔는지 로그로 추적할 수 없다.
      expect(PlayerActionSchema.safeParse({ action: "RAISE", amount: "1000" }).success).toBe(
        false,
      );
    });
  });

  describe("형태 자체가 틀린 입력", () => {
    it.each([null, undefined, 42, "FOLD", [], {}])("%p을 거부한다", (input) => {
      expect(PlayerActionSchema.safeParse(input).success).toBe(false);
    });

    it("숫자 액션을 거부한다", () => {
      // 마이그레이션 전 클라이언트가 남아 있어도 조용히 통과하지 않는다.
      expect(PlayerActionSchema.safeParse({ action: 3, amount: 1000 }).success).toBe(false);
    });
  });
});

describe("PlayerActionType", () => {
  it("모든 값이 스키마를 통과한다", () => {
    // 값 객체와 스키마가 어긋나면 프론트가 만든 액션을 서버가 거부한다.
    for (const action of Object.values(PlayerActionType)) {
      expect(PlayerActionTypeSchema.safeParse(action).success).toBe(true);
    }
  });

  it("스키마의 모든 액션에 대응하는 값이 있다", () => {
    expect(Object.keys(PlayerActionType).sort()).toEqual([...PLAYER_ACTIONS].sort());
  });
});
