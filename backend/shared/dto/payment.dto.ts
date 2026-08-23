import { IsInt, IsString, Max, Min } from "class-validator";

export class PayMentDto {

  @IsString()
  tournamentId: string;

}

export class RebuyDto {

  @IsString()
  tableId: string;

}
/**
 * 목업 충전의 상한(T72).
 *
 * 실 PG가 없어 금액을 정하는 바깥이 없다. 그래서 **경계에서 자른다** — T64가
 * 대회 입력에서 배운 것과 같은 자리다("경계에서 안 본 값이 한참 뒤에 터진다").
 * 상한이 없으면 오타 하나가 포인트를 무한히 찍고, 그 포인트는 프라이즈풀로
 * 흘러 전광판의 상금이 된다.
 */
export const CHARGE_AMOUNT_MAX = 1_000_000;

export class ChargePointDto {

  /**
   * 충전 금액. **정수만 받는다** — 포인트가 정수라 소수가 들어오면 Prisma의
   * `increment`가 던지거나 조용히 잘린다.
   */
  @IsInt()
  @Min(1)
  @Max(CHARGE_AMOUNT_MAX)
  amount: number;

}
