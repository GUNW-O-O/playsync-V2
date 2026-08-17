import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  storeName: string;
}

// 소유자(`ownerId`) 필드는 여기 없다. 예전에는 `updateStore`가 이 필드를
// 소유권 검사의 근거로 썼는데, 그 값을 보내는 쪽이 곧 검사 대상이라
// 남의 `ownerId`를 실어 보내면 그대로 통과했다. 소유자는 요청 본문이 아니라
// 토큰에서 온다.
export class UpdateStoreDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  storeName: string;
}
