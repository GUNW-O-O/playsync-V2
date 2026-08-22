import { PLAYER_ACTIONS } from "@playsync/contract";

export enum GamePhase {
  WAITING,
  PRE_FLOP,
  FLOP,
  TURN,
  RIVER,
  SHOWDOWN,
  HAND_END
}

/**
 * 서버 내부에서만 만들어지는 액션. 클라이언트는 보낼 수 없다.
 *
 * TIME_OUT은 타임아웃 프로세서가, DEALER_*는 딜러 경로가 만든다.
 * 클라이언트가 보낼 수 있는 것은 contract의 PLAYER_ACTIONS가 전부다.
 */
const INTERNAL_ACTIONS = ["TIME_OUT", "DEALER_KICK", "DEALER_FOLD"] as const;

export type ActionType =
  | (typeof PLAYER_ACTIONS)[number]
  | (typeof INTERNAL_ACTIONS)[number];

/**
 * 값이 문자열인 이유: 예전에는 숫자 enum이라 와이어에 `4`가 흘렀다. 로그를
 * 읽을 수 없었고, enum 중간에 멤버를 끼워 넣으면 뒤가 전부 한 칸씩 밀려
 * 다른 액션이 되는 버그가 가능했다.
 *
 * `satisfies`가 contract와의 드리프트를 막는다 — contract에 액션이 추가되면
 * 여기 키를 채울 때까지 컴파일이 통과하지 않는다.
 */
export const ActionType = {
  CHECK: "CHECK",
  CALL: "CALL",
  FOLD: "FOLD",
  RAISE: "RAISE",
  TIME_OUT: "TIME_OUT",
  DEALER_KICK: "DEALER_KICK",
  DEALER_FOLD: "DEALER_FOLD",
} as const satisfies Record<ActionType, ActionType>;

export interface TablePlayer {
  id: string;
  tableId: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  bet: number;
  hasFolded: boolean;
  hasChecked: boolean;
  isAllIn: boolean;
  totalContributed: number;
}

export interface TableState {
  phase: GamePhase;
  players: (TablePlayer | null)[];
  buttonUser: number;
  currentTurnSeatIndex: number;
  pot: number;
  sidePots: SidePot[];
  currentBet: number;
  smallBlind: number;
  /**
   * 앤티 금액이다. 0이면 앤티가 없다는 뜻이다.
   *
   * T58 전에는 `boolean`이었다 — `payAnte`가 그때마다 `smallBlind / 5`를
   * 다시 계산했다. 지금은 `DealerService.startPreFlop`과 `RecoveryService`가
   * `deriveAnteAmount`(`shared/util/util.ts`) 하나로 값을 만들어 여기 싣고,
   * `payAnte`는 계산하지 않고 이 값을 그대로 쓴다. `BlindLevelDto.ante`는
   * 여전히 `boolean`이다 — 구조는 "붙나"를 선언하고 상태는 "얼마인가"를 든다.
   */
  ante: number;
  actionDeadline?: number;
  /**
   * 타이머 세대. 타임아웃 잡을 새로 등록할 때마다 1씩 오른다.
   *
   * 잡은 자기가 예약된 세대를 들고 다니고, 실행 시점에 세대가 다르면 스스로
   * 폐기된다. 큐에서 잡을 지우는 데 성공했는지에 의존하지 않기 위한 것이다 —
   * 이미 실행 중인 잡은 제거할 수 없고, BullMQ는 at-least-once라 같은 잡이
   * 두 번 배달될 수도 있다.
   */
  timerEpoch?: number;

  /**
   * 이 라운드에서 마지막으로 있었던 **풀 레이즈의 폭**. 다음 최소 레이즈다.
   *
   * 노리밋 텍사스홀덤에서 레이즈는 직전 베팅·레이즈 증분 이상이어야 한다.
   * 프리플랍은 BB가 첫 베팅이라 시작값이 BB이고, 스트리트가 넘어가면 다시
   * BB로 돌아온다.
   *
   * **미달 올인은 이 값을 갱신하지 않는다.** 그 올인은 베팅을 다시 열지도
   * 않으므로, 다음 최소 레이즈는 마지막 *풀* 레이즈 기준 그대로다.
   *
   * 값이 없으면 BB로 본다 — 이 필드 이전에 만들어진 스냅샷(복구·진행 중인
   * 핸드)이 그렇다.
   *
   * `timerEpoch`와 달리 **계약에도 있다.** 화면이 최소 레이즈를
   * `currentBet + BB`로 잡으면 큰 레이즈 뒤에 불법 금액을 그리고, 사용자는
   * 누른 뒤에야 거절을 본다 — 판정은 엔진 하나지만 그 답은 경계를 넘어야 한다.
   */
  lastRaiseSize?: number;
  /**
   * 핸드 종료 체크포인트(DB 동기화)의 상태.
   *
   * 별도 이벤트가 아니라 스냅샷 필드인 이유: 딜러만이 아니라 테이블 전원이
   * 알아야 하고, 재접속한 단말도 같은 것을 봐야 한다. 스냅샷은 Redis에
   * 저장되고 재연결 시 그대로 렌더되므로 기존 브로드캐스트 경로를 그대로 탄다.
   *
   * 정상 진행 중에는 없다(`undefined`). 재시도에 들어갈 때만 나타난다.
   */
  dbSyncStatus?: 'RETRYING' | 'FAILED';
  tournamentId: string;
}

export interface SidePot {
  amount: number;
  relevantPlayerIds: string[];
}

/** 좌석 수. 한 테이블 아홉 자리로 고정이다. */
const SEAT_COUNT = 9;

/**
 * 아무도 앉지 않은 테이블의 상태.
 *
 * **`tableId`가 필드에 없는 것이 맞다.** 스냅샷은 `table:state:{tableId}`
 * 키에 저장되므로 테이블 신원은 키가 들고 있다. 여기 담기는 것은 그 테이블이
 * 어느 대회에 속하는지와 게임의 초기값이다.
 *
 * `smallBlind`는 자리 채움이다 — `startPreFlop`이 블라인드 구조에서 덮어쓴다
 * (`TableEngine.startPreFlop`).
 *
 * 이 함수가 생기기 전에는 같은 객체를 `EntryService`가 private으로 들고
 * 있었고, 그래서 **스냅샷을 만드는 지점이 착석 하나뿐**이었다. 상점이 연
 * 빈 테이블에는 상태가 없어, 딜러 화면이 부르는 `joinTable`이 500을 냈다.
 * 이제 테이블을 여는 쪽도 같은 껍데기를 세운다.
 */
export function createEmptyTableState(tournamentId: string): TableState {
  return {
    phase: GamePhase.WAITING,
    players: Array(SEAT_COUNT).fill(null),
    pot: 0,
    currentBet: 0,
    buttonUser: 0,
    currentTurnSeatIndex: -1,
    sidePots: [],
    ante: 0,
    tournamentId,
    smallBlind: 100,
  };
}