import { BlindLevelDto } from "shared/dto/blind-structure.dto";

/** 전광판에 뜨는 등수별 상금. 비율은 대회 생성 시 정해지고 금액은 파생된다. */
export interface PrizeRow {
  place: number,
  percent: number,
  amount: number,
}

export interface Dashboard {
  isRegistrationOpen: boolean,
  totalPlayer: number,
  activePlayer: number,
  totalBuyinAmount: number,
  // 상점이 걷은 총액에서 가져가는 비율(%). 참가자가 따로 내는 수수료가 아니다 —
  // 참가비는 그대로 걷히고 대회를 닫을 때 총액에 한 번 곱해 뗀다. 화면은 이
  // 값을 쓰지 않지만, 프라이즈풀이 왜 걷은 총액보다 작은지가 여기에 있다.
  rakePercent: number,
  rebuyUntil: number,
  avgStack: number,
  tournamentName: string,
  entryFee: number,
  startStack: number,
  // 엔트리 수 = 바이인 횟수. 사람 수가 아니다 — 리바인이 사람을 안 늘리고
  // 엔트리를 늘린다. 프라이즈풀과 상금권 인원의 분모가 이 값이다.
  entryCount: number,
  // 상금권 인원. 구간표에서 파생된다(`payoutsFor`). `prizes.length`와 같다.
  itmCount: number,

  // 프라이즈풀은 걷은 참가비 총액에서 **상점 몫을 뺀 나머지**다
  // (`prizePoolOf`). 리바인이 들어올 때마다 커지므로 전광판 숫자도 그 자리에서
  // 따라 오른다. 레이크가 0이면 걷은 총액과 같다.
  //
  // 지급의 진실은 DB다. 이 둘은 전광판용 파생값이라, 어긋나면 화면 숫자가
  // 틀리는 것이지 지급이 틀리는 것은 아니다.
  prizePool: number,
  prizes: PrizeRow[],
}

export interface BlindField {
  isBreak: boolean,
  startedAt: number,
  currentBlindLv: number,
  nextLevelAt: number,
  serverTime: number,
  blindStructure: BlindLevelDto[],
}

/**
 * 경계를 넘는 블라인드 레벨. 내부 `BlindLevelDto`와 다른 점은 **`ante`가
 * 금액**이라는 것 하나다(`toWireBlindStructure`).
 *
 * 두 모양을 나눈 이유: 내부 경로는 "앤티가 붙나"로 판단하고
 * (`deriveAnteAmount(sb, ante)`), 화면은 "얼마인가"를 그린다. 한 타입으로
 * 합치면 어느 쪽이든 상대의 뜻으로 읽는 자리가 생긴다.
 */
export interface WireBlindLevel {
  lv: number,
  sb: number,
  /** 앤티 금액. 0이면 없다는 뜻이다. */
  ante: number,
  duration: number,
}

export interface WireBlindField extends Omit<BlindField, 'blindStructure'> {
  blindStructure: WireBlindLevel[],
}

/** 전광판 응답. **경계 밖으로 나가는 봉투라 `blindField`가 금액형이다.** */
export interface FullTournamentInfo {
  dashboard: Dashboard,
  blindField: WireBlindField,
}