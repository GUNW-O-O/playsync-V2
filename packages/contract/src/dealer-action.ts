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
      // 동점 그룹의 배열이고 순서가 곧 순위다.
      // `[["a","b"], ["c"]]` = a와 b가 공동 1위, c가 3위.
      //
      // 평면 배열이 아닌 이유는 **보드 하이** 때문이다. 커뮤니티 카드가 그대로
      // 모두의 최고 핸드가 되면 살아남은 전원이 팟을 나눠 갖는데, 순위 배열로는
      // 그걸 표현할 방법이 아예 없었다 — 먼저 찍힌 사람이 전부 가져갔고 칩
      // 총량은 맞아서 아무 불변식도 울지 않았다.
      //
      // 안쪽 `.min(1)`이 필요한 이유: `[[]]`는 "1위가 아무도 없다"가 되어 그
      // 팟이 갈 곳을 잃는다.
      winnerGroups: z.array(z.array(userId).min(1)).min(1),
    })
    .strict(),
  z.object({ action: z.literal("DEALER_FOLD"), targetUserId: userId }).strict(),
  z.object({ action: z.literal("DEALER_KICK"), targetUserId: userId }).strict(),
  // 핸드 종료 체크포인트(DB 동기화)가 재시도까지 실패했을 때의 탈출구.
  // 멈춘 것 자체는 올바른 안전 상태이므로 되돌리는 명령이 아니라, 막다른
  // 골목을 없애는 명령이다.
  z.object({ action: z.literal("RETRY_CHECKPOINT") }).strict(),
]);

export type DealerAction = z.infer<typeof DealerActionSchema>;

/** 리바인 팝업 응답. 거절과 잘못된 요청이 구분되도록 accept는 필수다. */
export const RebuyResponseSchema = z.object({ accept: z.boolean() }).strict();

export type RebuyResponse = z.infer<typeof RebuyResponseSchema>;
