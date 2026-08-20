// /src/session/dto/blind-structure.dto.ts
import { IsString, IsArray, IsNotEmpty, ValidateNested, IsInt, Min, IsBoolean, ArrayNotEmpty, IsDivisibleBy } from 'class-validator';
import { Type } from 'class-transformer';

export class BlindLevelDto {
  @IsInt()
  @Min(1)
  lv: number;

  // T58. 앤티는 sb/5로 계산된다(deriveAnteAmount). sb가 5의 배수가 아니면
  // 앤티가 소수가 되어 스택과 팟이 소수가 되고, syncTableInventoryToDb가
  // Int 컬럼에 쓰다 실패해 그 테이블이 HAND_END에서 못 나온다(T62와 같은
  // 막다른 곳). Math.floor로 감추지 않고 입구에서 막는다.
  @IsInt()
  @Min(100)
  @IsDivisibleBy(5)
  sb: number;

  @IsBoolean()
  ante: boolean;

  // `@Min(10)`이었다. **한 번도 실행되지 않은 값이라** 그것이 옳다는 증거가
  // 없고, 반대 증거는 리포 안에 있다 — `seed.ts`의 `BLIND_STRUCTURE`가 3분
  // 레벨을 쓰고 이름이 '데모 (짧은 구조)'다. 터보·하이퍼는 실제로 3~5분
  // 레벨을 쓴다. 막아야 하는 것은 짧은 레벨이 아니라 0이다 — 0이면
  // `getCurrentBlindLevel`의 `accumulatedMs`가 안 늘어 그 레벨을 영영 못
  // 벗어난다.
  @IsInt()
  @Min(1)
  duration: number; // 분 단위
}

export class CreateBlindStructureDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  // 빈 배열을 여기서 막는다. 통과시키면 `getCurrentBlindLevel`이 모든 레벨을
  // 지난 경우에 읽는 `structure[structure.length - 1]`이 `structure[-1]`이 되어
  // `undefined.lv`로 죽는데, 그 자리가 **대회 시작**이라 참가자가 다 앉은
  // 뒤에 500이 난다.
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BlindLevelDto)
  structure: BlindLevelDto[]; // prisma의 Json 타입 대응

  @IsString()
  @IsNotEmpty()
  storeId: string;
}
