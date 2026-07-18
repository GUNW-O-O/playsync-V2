export enum GamePhase {
  WAITING,
  PRE_FLOP,
  FLOP,
  TURN,
  RIVER,
  SHOWDOWN,
  HAND_END
}

export enum ActionType {
  CHECK,
  CALL,
  FOLD,
  RAISE,
  TIME_OUT,
  DEALER_KICK,
  DEALER_FOLD,
}

// export type ActionInput = {
//   type : ActionType;
// }

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