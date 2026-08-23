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
 * class-validator의 `@IsInt()`는 `2^31`을 넘는 안전 정수를 통과시킨다.
 *
 * T74가 그 뒤에 그물을 하나 더 쳤다 — `PrismaExceptionFilter`가 범위 초과를
 * 400으로 내린다(postgres `22003`은 Prisma가 `P2020`으로 감싼다). **그래도
 * 경계는 여기다.** 필터는 이미 일어난 실패를 사람이 읽을 응답으로 바꿀 뿐이고,
 * `totalBuyinAmount` 같은 누적값은 대회 도중에 넘치므로 그때 400을 받는 것은
 * 잘못이 없는 참가자다.
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

/**
 * 상점 몫(레이크) 비율의 상한.
 *
 * **100은 못 쓴다.** 걷은 돈 전부가 상점으로 가면 프라이즈풀이 0이 되고,
 * `parsePayouts`가 요구하는 「합이 100인 분배율」이 나눌 것 없는 0을 나눈다 —
 * 상금이 전부 0인 대회가 만들어지는데 그건 대회가 아니다.
 *
 * 50은 실무 상한보다 훨씬 높다(홀덤펍이 10~20% 남짓). 넉넉히 두되 "상금보다
 * 상점이 더 가져가는 대회"는 만들 수 없게 한다.
 */
export const RAKE_PERCENT_MIN = 0;
export const RAKE_PERCENT_MAX = 50;

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

  // 상점이 걷은 총액에서 가져가는 비율(%). **참가자가 따로 내는 수수료가
  // 아니다** — 참가비는 그대로 걷히고, 대회를 닫을 때 `totalBuyinAmount`에
  // 한 번 곱해 뗀다. 안 주면 0이고 그때는 걷은 돈 전부가 상금으로 나간다.
  @IsInt()
  @IsOptional()
  @Min(RAKE_PERCENT_MIN)
  @Max(RAKE_PERCENT_MAX)
  rakePercent?: number;

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
  @Min(RAKE_PERCENT_MIN)
  @Max(RAKE_PERCENT_MAX)
  rakePercent?: number;

  @IsInt()
  @IsOptional()
  @Min(REBUY_UNTIL_MIN)
  @Max(REBUY_UNTIL_MAX)
  rebuyUntil?: number;

}
