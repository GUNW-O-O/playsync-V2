// src/session/dto/create-session.dto.ts
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GameType } from '@prisma/client';

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
  @Min(0)
  startStack: number;

  @IsInt()
  @Min(0)
  entryFee: number;

  @IsInt()
  @Min(0)
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
  startStack?: number;
  
  @IsInt()
  @IsOptional()
  entryFee?: number;

  @IsInt()
  @IsOptional()
  rebuyUntil?: number;

}