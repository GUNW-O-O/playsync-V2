// src/session/dto/create-session.dto.ts
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { GameType } from '@prisma/client';

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
  
  @IsInt()
  @Min(0)
  itmCount: number;

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

  @IsInt()
  @IsOptional()
  itmCount?: number;
  
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