// src/session/dto/create-session-body.dto.ts
import { IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateTournamentDto } from './tournament.dto';
import { CreateBlindStructureDto } from './blind-structure.dto';

/**
 * `POST /store/sessions`의 요청 본문 **봉투**.
 *
 * 예전에는 `dto`와 `blindStructure`를 각각 `@Body('dto')` · `@Body('blindStructure')`
 * 파라미터로 따로 받았다. `blindStructure`는 선택값이라 `@IsOptional()`을 달았는데,
 * 그 데코레이터는 **필드** 데코레이터라 파라미터 레벨에는 아무 효과가 없다.
 * Nest `ValidationPipe.transform`은 `toEmptyIfNil(value, metatype)`에서
 * **metatype이 클래스면 nil을 `{}`로 승격한 뒤 그대로 검증한다** — `blindStructure`를
 * 생략한 정상 요청(`dto.blindId`로 기존 구조를 재사용하는 경로)이 빈 객체 취급을
 * 받아 `CreateBlindStructureDto`의 `name`·`structure`·`storeId` 필수 검사에 걸려
 * 400이 났다. 예전 타입(`any`)일 때는 `toValidate()`가 false를 돌려줘 통째로
 * 넘어갔던 것이 `CreateBlindStructureDto`로 바뀌며 드러난 회귀다.
 *
 * 봉투 하나로 받으면 `@IsOptional()`이 **필드** 데코레이터로서 제대로 걸려
 * `blindStructure`가 없는 요청은 건너뛰고, 있는 요청만 중첩 검증을 탄다.
 * 요청 본문의 키 이름(`dto` · `blindStructure`)은 그대로라 호출자가 바뀌지 않는다.
 */
export class CreateSessionBody {
  @ValidateNested()
  @Type(() => CreateTournamentDto)
  dto: CreateTournamentDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateBlindStructureDto)
  blindStructure?: CreateBlindStructureDto;
}
