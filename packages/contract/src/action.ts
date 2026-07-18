import { z } from "zod";

/**
 * 클라이언트가 보낼 수 있는 액션의 전부.
 *
 * TIME_OUT, DEALER_KICK, DEALER_FOLD는 서버 내부에서만 만들어진다. 그것들을
 * 여기 넣지 않는 것이 이 파일의 핵심이다 — 백엔드가 화이트리스트 배열을 따로
 * 관리하면 액션이 늘어날 때 갱신을 잊는 순간 다시 뚫리지만, 스키마가 곧
 * 화이트리스트면 그 실수를 할 수 없다.
 *
 * 값이 문자열인 이유: 예전에는 숫자 enum이라 와이어에 `4`가 흘렀다. 로그를
 * 읽을 수 없었고, enum 중간에 멤버를 하나 끼워 넣으면 그 뒤 액션이 전부 한 칸씩
 * 밀려 다른 액션이 되는 버그가 가능했다.
 */
export const PLAYER_ACTIONS = ["CHECK", "CALL", "FOLD", "RAISE"] as const;

export const PlayerActionTypeSchema = z.enum(PLAYER_ACTIONS);
export type PlayerActionType = z.infer<typeof PlayerActionTypeSchema>;

/**
 * 클라이언트가 액션을 만들 때 쓰는 값. 문자열 리터럴을 직접 적는 대신 이걸 쓴다.
 *
 * `satisfies`가 PLAYER_ACTIONS와의 드리프트를 막는다 — 액션이 추가되면
 * 여기 키를 채울 때까지 컴파일이 통과하지 않는다.
 */
export const PlayerActionType = {
  CHECK: "CHECK",
  CALL: "CALL",
  FOLD: "FOLD",
  RAISE: "RAISE",
} as const satisfies Record<PlayerActionType, PlayerActionType>;

/**
 * 인바운드(클라 → 서버)이므로 `.strict()`. 모르는 키가 오면 거부한다.
 *
 * 액션별로 나눠 정의하는 이유: `{ action, amount? }` 한 덩어리로 두면
 * "금액 없는 RAISE"와 "금액 붙은 FOLD"가 둘 다 통과한다. 액션마다 필요한
 * 필드가 다르다는 사실을 타입이 알고 있어야 경계에서 걸린다.
 */
export const PlayerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CHECK") }).strict(),
  z.object({ action: z.literal("CALL") }).strict(),
  z.object({ action: z.literal("FOLD") }).strict(),
  z
    .object({
      action: z.literal("RAISE"),
      // 칩은 정수다. 소수/NaN/Infinity는 int()가 모두 거른다.
      amount: z.int().positive(),
    })
    .strict(),
]);

export type PlayerAction = z.infer<typeof PlayerActionSchema>;
