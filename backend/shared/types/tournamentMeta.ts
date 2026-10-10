import { BlindLevelDto } from "shared/dto/blind-structure.dto";

import type {
  BlindField as ContractBlindField,
  BlindLevel as ContractBlindLevel,
} from '@playsync/contract';

/**
 * 경계를 넘는 모양은 **계약이 정본이다**(`packages/contract/src/dashboard.ts`). 여기서
 * 같은 필드를 손으로 다시 적어 두었더니 주석까지 두 벌이 됐다 — 한쪽에 필드를
 * 늘리면 다른 쪽이 조용히 어긋난다(T129). 필드의 뜻은 계약 쪽 주석에 있다.
 */
export type { Dashboard, FullTournamentInfo, PrizeRow } from '@playsync/contract';

/**
 * 내부용 블라인드 메타. 계약의 것과 다른 점은 **`ante`가 boolean**이라는 것 하나다
 * (`BlindLevelDto`). 내부 경로는 「앤티가 붙나」로 판단하고(`deriveAnteAmount`),
 * 화면은 「얼마인가」를 그린다 — 경계에서 금액으로 바꾼다(`toWireBlindStructure`).
 */
export interface BlindField {
  isBreak: boolean,
  startedAt: number,
  currentBlindLv: number,
  nextLevelAt: number,
  serverTime: number,
  blindStructure: BlindLevelDto[],
  /**
   * 정지가 시작된 시각(epoch ms). **있으면 시계가 멈춰 있다**(T96).
   * DB `Tournament.pausedAt`의 사본이다 — 부팅이 대입하고 `completeSync`가 지운다.
   */
  pausedAt?: number,
}

/** 경계를 넘는 블라인드 레벨 — `ante`가 금액이다. */
export type WireBlindLevel = ContractBlindLevel;

/** 경계를 넘는 블라인드 메타. */
export type WireBlindField = ContractBlindField;
