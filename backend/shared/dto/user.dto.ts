import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginUserDto {
  
  @IsNotEmpty()
  @IsString()
  nickname: string;
  
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password: string;
}

export class CreateUserDto {
  
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(10)
  nickname: string;
  
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password: string;
}