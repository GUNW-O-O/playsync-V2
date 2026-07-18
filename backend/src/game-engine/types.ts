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
  ante: boolean;
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
  tournamentId: string;
}

export interface SidePot {
  amount: number;
  relevantPlayerIds: string[];
}