import { TournamentStatusSchema, ClosedTournamentStatusSchema } from "./index";

it("닫힌 상태는 전체 상태의 부분집합이다", () => {
  for (const s of ClosedTournamentStatusSchema.options) {
    expect(TournamentStatusSchema.options).toContain(s);
  }
});
