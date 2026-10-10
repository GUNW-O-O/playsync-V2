import { z } from "zod";

/**
 * 리바인을 묻는 알림(`REBUY_PROMPT`)의 **공개형**. 파산한 좌석 단말 하나에만 간다.
 *
 * 게이트웨이가 내보내는 이벤트 가운데 이것만 계약이 없었다 — 프론트가 손으로 적은
 * 타입을 `as`로 씌웠고, 백엔드는 `userPoints: any`를 그대로 실어 보냈다. 스키마를
 * 태우는 자리가 있어야 「아웃바운드는 스트립」이 사실이 된다(`WsGateway.handleRebuyRequest`).
 *
 * **`deadline`만 필수다.** 나머지가 빠져도 팝업은 떠야 한다 — 여기서 통째로 버리면
 * 정작 필요한 「거절」 버튼까지 사라지고, 그 사람은 답할 길 없이 마감을 맞는다.
 * 서버는 넷 다 채워 보낸다.
 *
 * 아웃바운드라 `.strict()`를 걸지 않는다. zod 기본 스트립이 그물이다.
 */
export const RebuyPromptSchema = z.object({
  /** 응답 마감(epoch ms, 서버 시계). */
  deadline: z.int(),
  /** 지금 가진 포인트. 참가비를 낼 수 있는지 화면이 보여 준다. */
  userPoints: z.object({ points: z.int() }).optional(),
  entryFee: z.int().optional(),
  tournamentName: z.string().optional(),
});

export type RebuyPrompt = z.infer<typeof RebuyPromptSchema>;
