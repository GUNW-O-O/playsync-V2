// 이 스펙은 Nest 부트스트랩(main.ts)을 거치지 않고 DTO를 직접 로드한다.
// `seat-release.dto.spec.ts`와 같은 이유로 reflect-metadata를 먼저 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBlindStructureDto } from './blind-structure.dto';

function validate(payload: unknown) {
  return validateSync(plainToInstance(CreateBlindStructureDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

const has = (errs: unknown[]) => `오류 ${errs.length > 0 ? '있음' : '없음'}`;
const 정상 = { name: '표준', storeId: 's1', structure: [{ lv: 1, sb: 100, ante: false, duration: 10 }] };

describe('CreateBlindStructureDto', () => {
  // 빈 배열이 통과하면 `getCurrentBlindLevel`이 `structure[-1]`을 읽어
  // "Cannot read properties of undefined (reading 'lv')"로 죽는다. 터지는 자리가
  // **대회 시작**이라, 참가자가 다 앉은 뒤에 500이 난다.
  it('빈 구조를 거부한다', () => {
    expect(has(validate({ ...정상, structure: [] }))).toBe('오류 있음');
  });

  // 막아야 하는 것은 "짧은 레벨"이 아니라 0이다. 0이면
  // `getCurrentBlindLevel`의 `accumulatedMs`가 안 늘어 그 레벨을 영영 못
  // 벗어난다. 3분짜리 터보 레벨은 실제로 쓰는 값이고, 시드가 이미 쓴다.
  it('duration 0을 거부한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: false, duration: 0 }] }))).toBe('오류 있음');
  });

  it('3분짜리 터보 레벨은 통과한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: false, duration: 3 }] }))).toBe('오류 없음');
  });

  it('레벨의 sb 하한을 본다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 50, ante: false, duration: 10 }] }))).toBe('오류 있음');
  });

  // T58. 앤티는 sb/5로 계산된다(deriveAnteAmount, shared/util/util.ts). sb가
  // 5의 배수가 아니면 앤티가 소수가 되어 스택과 팟이 소수가 되고,
  // syncTableInventoryToDb가 Int 컬럼에 쓰다 실패해 그 테이블이 HAND_END에서
  // 못 나온다. 코드가 Math.floor로 감추지 않으므로 입구에서 막아야 한다.
  it('5의 배수가 아닌 sb를 거부한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 101, ante: false, duration: 10 }] }))).toBe('오류 있음');
  });

  it('5의 배수인 sb는 통과한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 105, ante: false, duration: 10 }] }))).toBe('오류 없음');
  });

  it('ante가 boolean이 아니면 거부한다', () => {
    expect(has(validate({ ...정상, structure: [{ lv: 1, sb: 100, ante: 'yes', duration: 10 }] }))).toBe('오류 있음');
  });

  it('정상 구조는 통과한다', () => {
    expect(has(validate(정상))).toBe('오류 없음');
  });
});
