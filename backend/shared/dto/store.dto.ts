import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  storeName: string;
}

export class UpdateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  storeName: string;

  @IsString()
  @IsNotEmpty()
  @IsString()
  ownerId: string;
}
