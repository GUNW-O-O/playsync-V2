// 이 스펙은 Nest 부트스트랩(main.ts)을 거치지 않고 DTO를 직접 로드한다.
// `seat-release.dto.spec.ts`와 같은 이유로 reflect-metadata를 먼저 불러온다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateTournamentDto,
  UpdateTournamentDto,
  ENTRY_FEE_MAX,
  START_STACK_MAX,
  REBUY_UNTIL_MAX,
} from './tournament.dto';

/** ValidationPipe가 하는 것과 같은 순서. */
function validate(cls: any, payload: unknown) {
  return validateSync(plainToInstance(cls, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

const validCreate = {
  name: '주말 딥스택',
  type: 'TOURNAMENT',
  storeId: 's1',
  blindId: 'b1',
  startStack: 30000,
  entryFee: 50000,
  rebuyUntil: 5,
  payoutTable: [{ minEntries: 0, payouts: [{ place: 1, percent: 100 }] }],
};

const has = (errs: unknown[]) => `오류 ${errs.length > 0 ? '있음' : '없음'}`;

describe('대회 DTO의 경계', () => {
  // 아래 표가 이 티켓의 요점이다. **두 DTO가 같은 값을 같이 거부해야** 한다 —
  // 지금은 Update 쪽에 하한이 없어서 PATCH로 음수를 넣을 수 있고, 그것이
  // `paymentPoint`의 `decrement: -50000`으로 포인트를 찍어낸다.
  const cases: { 필드: 'entryFee' | 'startStack' | 'rebuyUntil'; 값: number; 왜: string }[] = [
    { 필드: 'entryFee', 값: 0, 왜: 'recalculateAvgStack이 0으로 나눠 NaN이 되고 전광판이 멎는다' },
    { 필드: 'entryFee', 값: -50000, 왜: 'paymentPoint의 decrement가 음수라 포인트를 발행한다' },
    { 필드: 'entryFee', 값: ENTRY_FEE_MAX + 1, 왜: '만 명이 낼 때 totalBuyinAmount가 postgres integer를 넘긴다' },
    { 필드: 'startStack', 값: -1, 왜: 'currentStack이 음수가 되어 칩 보존이 깨진다' },
    { 필드: 'startStack', 값: START_STACK_MAX + 1, 왜: '같은 22003' },
    { 필드: 'rebuyUntil', 값: -1, 왜: '레벨 번호와 비교되는 값이라 음수가 뜻을 갖지 않는다' },
    { 필드: 'rebuyUntil', 값: REBUY_UNTIL_MAX + 1, 왜: '휴식 센티널 99를 넘는 레벨은 없다' },
  ];

  for (const { 필드, 값, 왜 } of cases) {
    it(`Create는 ${필드}=${값}을 거부한다 — ${왜}`, () => {
      expect(has(validate(CreateTournamentDto, { ...validCreate, [필드]: 값 }))).toBe('오류 있음');
    });

    it(`Update도 ${필드}=${값}을 거부한다 — 두 DTO가 갈라지면 수정 경로만 뚫린다`, () => {
      expect(has(validate(UpdateTournamentDto, { [필드]: 값 }))).toBe('오류 있음');
    });
  }

  it('정상값은 Create·Update 둘 다 통과한다', () => {
    expect(has(validate(CreateTournamentDto, validCreate))).toBe('오류 없음');
    expect(has(validate(UpdateTournamentDto, { entryFee: 50000, startStack: 30000, rebuyUntil: 5 })))
      .toBe('오류 없음');
  });
});
