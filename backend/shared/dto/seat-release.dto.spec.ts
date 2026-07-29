// 이 스펙은 Nest 부트스트랩(main.ts)을 거치지 않고 DTO를 직접 로드한다.
// 데코레이터(@Type 등)가 의존하는 Reflect.getMetadata는 원래 `@nestjs/core`가
// 부트스트랩 시점에 부작용으로 불러오는데(node_modules/@nestjs/core/index.js가
// `require('reflect-metadata')`를 한다), 이 파일은 그 경로를 타지 않으므로
// 직접 불러와야 한다. 없으면 `ReleaseSeatsDto` 클래스 선언 자체가
// "Reflect.getMetadata is not a function"으로 죽는다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReleaseSeatsDto } from './seat-release.dto';

/** ValidationPipe가 하는 것과 같은 순서. */
function validate(payload: unknown) {
  return validateSync(plainToInstance(ReleaseSeatsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('ReleaseSeatsDto', () => {
  it('좌석 번호가 범위 밖이면 거부한다', () => {
    const errors = validate({ seats: [{ seatIndex: 9, userId: 'u1' }] });
    expect(`중첩 오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('중첩 오류 있음');
  });

  it('userId가 없으면 거부한다', () => {
    const errors = validate({ seats: [{ seatIndex: 3 }] });
    expect(`중첩 오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('중첩 오류 있음');
  });

  it('빈 배열을 거부한다', () => {
    const errors = validate({ seats: [] });
    expect(`오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('오류 있음');
  });

  it('올바른 요청은 통과한다', () => {
    const errors = validate({ seats: [{ seatIndex: 3, userId: 'u1' }] });
    expect(`오류 ${errors.length > 0 ? '있음' : '없음'}`).toBe('오류 없음');
  });
});
