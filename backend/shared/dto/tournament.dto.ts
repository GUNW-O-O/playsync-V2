// src/session/dto/create-session.dto.ts
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GameType } from '@prisma/client';

/**
 * 두 DTO가 **같은 상수**를 쓴다. 예전에는 `Create`에만 `@Min(0)`이 있고
 * `Update`에는 아무것도 없어서, `PATCH /store/sessions/:id`로 `entryFee: -50000`을
 * 넣으면 `paymentPoint`의 `decrement: -50000`이 포인트를 찍어냈다. 값이 한 곳에
 * 있으면 한쪽만 고쳐지는 날이 오지 않는다.
 *
 * 상한이 있는 이유는 Prisma `Int`가 postgres `integer`이기 때문이다.
 * class-validator의 `@IsInt()`는 `2^31`을 넘는 안전 정수를 통과시키고, 리포에
 * 예외 필터가 없어 22003이 그대로 500으로 나간다.
 *
 * **`ENTRY_FEE_MAX`는 단발 값이 아니라 누적에서 역산한다.** `entryFee` 자체를
 * `Int` 상한(2,147,483,647) 아래로 막는 것만으로는 부족하다 — 실제로 터지는
 * 것은 그 값이 누적되는 `Tournament.totalBuyinAmount`(역시 `Int`)이고, 그 값은
 * 대회 도중에 참가·리바인이 쌓이며 커진다. T57이 594테이블(5,346명)을 실측한
 * 리포라 참가자 규모를 만 명으로 잡으면, `200_000 × 10_000 = 2,000,000,000 <
 * 2^31`이 안전한 상한이고 홀덤펍 참가비의 현실적 범위이기도 하다.
 */
export const ENTRY_FEE_MIN = 1;
export const ENTRY_FEE_MAX = 200_000;
export const START_STACK_MIN = 1;
export const START_STACK_MAX = 1_000_000_000;
export const REBUY_UNTIL_MIN = 0;
/** 휴식 레벨의 센티널이 `lv: 99`라 그 위의 레벨 번호는 없다. */
export const REBUY_UNTIL_MAX = 99;

/** 프라이즈풀에서 한 등수가 가져가는 몫. 전체 합이 100이어야 한다. */
export class PrizePayoutDto {
  @IsInt()
  @Min(1)
  place: number;

  @IsInt()
  @Min(1)
  percent: number;
}

export class CreateTournamentDto {
  @IsString()
  name: string;

  @IsEnum(GameType)
  type: GameType;

  @IsString()
  storeId: string;

  @IsString()
  @IsOptional()
  blindId?: string;

  @IsInt()
  @Min(START_STACK_MIN)
  @Max(START_STACK_MAX)
  startStack: number;

  // 0을 막는 이유: `recalculateAvgStack`이 `totalBuyinAmount / entryFee`로
  // 바이인 건수를 역산한다. 0이면 `0 / 0 = NaN`이 해시에 들어가고,
  // `DashboardSchema.avgStack`이 `safeParse`에서 거부해 전광판이 "대기 중"에
  // 영구히 머문다. 같은 값이 `processRebuy`의 포인트 게이트도 무력화한다.
  @IsInt()
  @Min(ENTRY_FEE_MIN)
  @Max(ENTRY_FEE_MAX)
  entryFee: number;

  @IsInt()
  @Min(REBUY_UNTIL_MIN)
  @Max(REBUY_UNTIL_MAX)
  rebuyUntil: number;

  // itmCount는 여기서 받지 않는다. 분배율 항목 수에서 파생된다 — 따로 받으면
  // "인 더 머니인데 받을 몫이 없는 등수"가 만들어질 수 있다.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PrizePayoutDto)
  prizePayouts: PrizePayoutDto[];

  @IsBoolean()
  @IsOptional()
  isRegistrationOpen: boolean;

}

export class UpdateTournamentDto {

  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  @IsOptional()
  blindId?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PrizePayoutDto)
  prizePayouts?: PrizePayoutDto[];


  @IsInt()
  @IsOptional()
  @Min(START_STACK_MIN)
  @Max(START_STACK_MAX)
  startStack?: number;

  @IsInt()
  @IsOptional()
  @Min(ENTRY_FEE_MIN)
  @Max(ENTRY_FEE_MAX)
  entryFee?: number;

  @IsInt()
  @IsOptional()
  @Min(REBUY_UNTIL_MIN)
  @Max(REBUY_UNTIL_MAX)
  rebuyUntil?: number;

}
