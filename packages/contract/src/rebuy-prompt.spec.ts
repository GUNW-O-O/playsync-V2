import { RebuyPromptSchema } from "./rebuy-prompt";

describe("RebuyPromptSchema", () => {
  it("스키마에 없는 키는 떨어진다 — userPoints에 딸려 온 것도", () => {
    const parsed = RebuyPromptSchema.parse({
      deadline: 1000,
      userPoints: { points: 500, password: "x" },
      entryFee: 100,
      tournamentName: "T",
      generation: 3,
    });

    expect(parsed).toEqual({ deadline: 1000, userPoints: { points: 500 }, entryFee: 100, tournamentName: "T" });
  });

  it("마감만 있어도 통과한다 — 팝업은 떠야 한다", () => {
    expect(RebuyPromptSchema.safeParse({ deadline: 1000 }).success).toBe(true);
  });

  it("마감이 없으면 거부한다 (반대 입력)", () => {
    expect(RebuyPromptSchema.safeParse({ entryFee: 100 }).success).toBe(false);
  });
});
