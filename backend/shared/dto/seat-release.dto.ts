import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';

/**
 * 해제할 좌석 하나.
 *
 * `userId`를 함께 받는 이유: 상점 콘솔은 조금 전에 그린 판을 보고 체크한다.
 * 그 사이 그 자리 사람이 탈락하고 다른 사람이 OTP로 앉았을 수 있다 — T28이
 * 핸드 도중 착석을 허용하므로 창은 항상 열려 있다. 좌석 번호만 받으면 엉뚱한
 * 사람을 뗀다.
 */
export class ReleaseSeatItem {
  @IsInt()
  @Min(0)
  @Max(8)
  seatIndex: number;

  @IsString()
  userId: string;
}

export class ReleaseSeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReleaseSeatItem)
  seats: ReleaseSeatItem[];
}
