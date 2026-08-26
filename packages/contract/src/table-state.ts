import { z } from "zod";

/**
 * 테이블 스냅샷의 **공개형**. `renderGame`으로 나가는 것이 전부 여기 있다.
 *
 * 아웃바운드라 `.strict()`를 걸지 않는다. zod 기본 스트립이 목적이다 —
 * 백엔드 `TableState`에 필드를 추가해도 여기 없으면 조용히 제거되므로
 * 내부 값이 자동으로 새지 않는다. `.strict()`를 걸면 그 순간 백엔드가
 * 필드를 하나 늘릴 때마다 브로드캐스트가 통째로 죽는다.
 *
 * **그 스트립이 실제로 일어나는 자리는 `WsGateway.toWireState` 하나다.**
 * T71 전에는 이 문단이 거짓이었다 — 스키마의 프로덕션 사용처가 0건이라
 * 게이트웨이가 백엔드 객체를 원시로 쐈고, `timerEpoch`와 좌석마다 반복되는
 * `tableId`가 그대로 나가고 있었다. 스키마는 실행돼야 계약이 된다.
 *
 * 프론트는 이 파일의 타입을 그대로 import한다. 손으로 복사한 판이 따로 있으면
 * 백엔드가 필드를 늘렸을 때 조용히 어긋나는데, 계약을 읽으면 **계약에 없는
 * 필드는 애초에 못 읽는다** — 런타임 유실이 아니라 컴파일 에러가 된다.
 *
 * 카드가 없는 것은 누락이 아니다. 이 시스템은 오프라인 홀덤을 다루고
 * 카드는 사람 딜러가 실물로 딜링한다. 덱도 홀카드도 커뮤니티 카드도
 * 서버에 존재하지 않는다.
 */

/**
 * 핸드의 진행 단계.
 *
 * 백엔드 `game-engine/types.ts`의 것을 값까지 그대로 미러링한다. 지금
 * 와이어에 `phase: 1`처럼 숫자가 흐르고 있어, 스키마가 그 형식을 바꾸면
 * 계약이 아니라 변환이 된다.
 *
 * **같은 파일의 `ActionType`은 이미 문자열로 옮겼다** — 숫자 enum은 로그를
 * 읽을 수 없고, 중간에 멤버를 끼워 넣으면 뒤가 한 칸씩 밀려 다른 값이 되기
 * 때문이다. `GamePhase`에는 그 문제가 그대로 남아 있다. 문자열 마이그레이션은
 * 백엔드와 함께 움직여야 해서 별건으로 둔다.
 */
export enum GamePhase {
  WAITING,
  PRE_FLOP,
  FLOP,
  TURN,
  RIVER,
  SHOWDOWN,
  HAND_END,
}

export const GamePhaseSchema = z.enum(GamePhase);

/** 칩은 정수다. 소수가 통과하면 사이드팟 분배에서 조용히 어긋난다. */
const chips = z.int().min(0);

const userId = z.string().min(1);

/**
 * 좌석에 앉은 사람.
 *
 * 백엔드 `TablePlayer`의 `tableId`는 여기 없다. 좌석마다 같은 값이 반복되는데
 * 스냅샷 자체가 이미 그 테이블이다.
 */
export const TablePlayerSchema = z.object({
  id: userId,
  nickname: z.string(),
  seatIndex: z.int().min(0),
  stack: chips,
  bet: chips,
  hasFolded: z.boolean(),
  hasChecked: z.boolean(),
  isAllIn: z.boolean(),
  totalContributed: chips,
});

export type TablePlayer = z.infer<typeof TablePlayerSchema>;

/** 올인이 갈라놓은 팟 하나와, 거기에 자격이 있는 사람들. */
export const SidePotSchema = z.object({
  amount: chips,
  relevantPlayerIds: z.array(userId),
});

export type SidePot = z.infer<typeof SidePotSchema>;

export const TableStateSchema = z.object({
  phase: GamePhaseSchema,
  /** 인덱스가 곧 좌석 번호다. 빈 자리는 `null`이라 걸러내면 번호가 밀린다. */
  players: z.array(TablePlayerSchema.nullable()),
  buttonUser: z.int(),
  /** 차례가 없을 때가 있다 — 쇼다운에는 아무도 행동하지 않는다. */
  currentTurnSeatIndex: z.int(),
  pot: chips,
  sidePots: z.array(SidePotSchema),
  currentBet: chips,
  smallBlind: chips,
  /**
   * 앤티 금액. 0이면 없다는 뜻이다.
   *
   * T58 전에는 `boolean`이었다. 화면(`Felt`)이 금액을 직접 계산하지 않고
   * 여기서 받아 그리게 하려는 것이었다.
   *
   * `BlindLevelSchema.ante`(대회 블라인드 구조 쪽)도 뒤따라 금액이 됐다 —
   * 전광판이 같은 이유로 금액을 필요로 했다. 두 스키마가 같은 모양인 것은
   * 우연이 아니라 규칙이다: **경계를 넘는 앤티는 언제나 금액이고, "붙나"는
   * DB와 입력 DTO에만 남는다.**
   */
  ante: chips,
  actionDeadline: z.int().optional(),
  /**
   * 핸드 종료 체크포인트(DB 동기화)의 상태. 정상 진행 중에는 없다.
   *
   * 별도 이벤트가 아니라 스냅샷 필드인 것은 설계다 — 딜러만이 아니라 테이블
   * 전원이 알아야 하고, 재접속한 단말도 같은 것을 봐야 한다.
   */
  dbSyncStatus: z.enum(["RETRYING", "FAILED"]).optional(),
  /**
   * 지금 리바인 답을 기다리는 중. 기다릴 사람이 없으면 없다.
   *
   * **`dbSyncStatus`와 같은 이유로 스냅샷 필드다.** 한 핸드에서 스택이 0이
   * 된 사람에게 서버가 리바인을 물어보고 최대 15초를 기다리는데, 그동안
   * 판이 멈춘다. 그 15초가 **테이블 전원에게 아무 설명 없는 정지**였다 —
   * 딜러 화면은 「쇼다운」 배지에 「승자 결정」 버튼이 활성인 채로 남아,
   * 다시 누르면 「쇼다운 상태가 아닙니다」로 거절당했다. 남은 좌석들도
   * 마지막 펠트를 그대로 들고 있었다.
   *
   * 별도 이벤트로 하지 않은 이유도 같다 — 그 15초 안에 재접속한 단말은
   * 지나간 이벤트를 못 받지만 스냅샷은 접속할 때 한 번 받는다
   * (`WsGateway.handleConnection`).
   */
  rebuyPending: z
    .object({
      /**
       * 답을 기다리는 자리. **비어 있을 수 없다** — 아무도 안 기다리는데
       * 필드가 서 있으면 화면이 「리바인을 기다립니다」를 띄운 채 아무 일도
       * 일어나지 않는다. 그럴 때는 필드 자체가 없어야 한다.
       *
       * 사람이 아니라 **자리**를 싣는다. 딜러가 보는 것은 눈앞의 테이블이라
       * 「3번 자리」가 곧 안내할 대상이고, 화면도 그 자리를 짚을 수 있다.
       */
      seatIndexes: z.array(z.int().min(0)).min(1),
      /**
       * 서버가 정한 마감(epoch ms). `actionDeadline`과 같은 꼴이라 화면이
       * 같은 타이머(`ActionTimer`)를 쓴다.
       */
      deadline: z.int(),
    })
    .optional(),
  /**
   * 이 라운드에서 마지막으로 있었던 **풀 레이즈의 폭**. 다음 최소 레이즈다.
   *
   * 노리밋 텍사스홀덤에서 레이즈는 직전 베팅·레이즈 증분 이상이어야 한다.
   * 프리플랍은 BB가 첫 베팅이라 BB에서 시작하고, 스트리트가 넘어가면 다시
   * BB로 돌아온다. 미달 올인은 이 값을 갱신하지 않는다.
   *
   * **경계를 넘어야 하는 값이다.** 화면이 최소 레이즈를 `currentBet + BB`로
   * 잡으면 큰 레이즈 뒤에 불법 금액을 슬라이더에 그리고, 사용자는 누른 뒤에야
   * 거절을 본다. 값이 없으면 BB로 본다(옛 스냅샷).
   */
  lastRaiseSize: chips.optional(),
  /**
   * **이 스냅샷이 서버를 떠난 시각.** 상태가 아니라 봉투에 찍는 도장이다.
   *
   * `actionDeadline`은 서버가 만든 절대 시각인데, 단말이 그것을 자기
   * `Date.now()`와 직접 비교하면 시계가 뒤처진 태블릿은 게이지가 남은 채
   * 자동 폴드되고 앞선 태블릿은 지난 턴을 계속 센다. 전광판은 같은 이유로
   * `blindField.serverTime`을 쓴다 — 좌석 태블릿에도 같은 재료가 필요하다.
   *
   * 스냅샷에는 저장하지 않는다. `WsGateway.toWireState`가 내보낼 때 찍는다.
   */
  serverTime: z.int().optional(),
  tournamentId: z.string().min(1),
});

export type TableState = z.infer<typeof TableStateSchema>;

/**
 * 브로드캐스트 봉투.
 *
 * 이벤트 이름을 리터럴로 박아야 클라이언트가 `renderSeatList`, `REBUY_PROMPT`와
 * 갈라낼 수 있다. 셋은 페이로드가 서로 다르다.
 */
export const RenderGameEventSchema = z.object({
  event: z.literal("renderGame"),
  data: TableStateSchema,
});

export type RenderGameEvent = z.infer<typeof RenderGameEventSchema>;
