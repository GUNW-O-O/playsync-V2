import { z } from "zod";

/**
 * 딜러가 보내는 진행 명령.
 *
 * 이 프로젝트에서 딜러는 사람이고 실물 카드를 딜링한다. 그래서 승자는 서버가
 * 계산하는 값이 아니라 딜러가 보고 입력하는 값이고, 검증할 정답이 존재하지
 * 않는다. 딜러 입력을 신뢰할 수밖에 없는 만큼, **누가 딜러인지**와 **어느
 * 테이블의 딜러인지**는 게이트웨이에서 반드시 확인해야 한다.
 *
 * 여기 정의된 것은 형태(shape)뿐이다. 권한은 스키마가 아니라 게이트웨이가 본다.
 */
const userId = z.string().min(1);

export const DealerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("START_PRE_FLOP") }).strict(),
  z
    .object({
      action: z.literal("RESOLVE_WINNERS"),
      // 순서가 곧 순위다. 사이드팟 분배가 이 순서를 그대로 쓴다.
      winnerUserIds: z.array(userId).min(1),
    })
    .strict(),
  z.object({ action: z.literal("DEALER_FOLD"), targetUserId: userId }).strict(),
  z.object({ action: z.literal("DEALER_KICK"), targetUserId: userId }).strict(),
]);

export type DealerAction = z.infer<typeof DealerActionSchema>;

/** 리바인 팝업 응답. 거절과 잘못된 요청이 구분되도록 accept는 필수다. */
export const RebuyResponseSchema = z.object({ accept: z.boolean() }).strict();

export type RebuyResponse = z.infer<typeof RebuyResponseSchema>;
