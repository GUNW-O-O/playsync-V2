// C-1. 이 스펙만은 DTO를 `validateSync`로 직접 태우지 않고 실제
// `ValidationPipe.transform`을 부른다 — 회귀가 DTO 규칙이 아니라 **파이프가
// 파라미터를 다루는 방식**(`toEmptyIfNil`)에 있었기 때문이다. `validateSync`는
// 이미 만들어진 인스턴스만 보므로 그 승격을 재현하지 못한다.
//
// 리포에 HTTP 계층 테스트(supertest 등)가 없다 — main.ts를 통째로 띄우지
// 않고, 파이프를 `main.ts`와 같은 옵션으로 직접 구성해 그 옵션이 실제로
// 만드는 승격만 잘라서 본다. 이것이 이 회귀가 닿는 유일한 seam이다.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { CreateSessionBody } from 'shared/dto/create-session-body.dto';

function pipe() {
  // main.ts의 `app.useGlobalPipes(...)`와 같은 옵션. 다르면 이 스펙이
  // 실제로 지키는 것이 실제 파이프가 아니게 된다.
  return new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
}

const validTournament = {
  name: '주말 딥스택',
  type: 'TOURNAMENT',
  storeId: 's1',
  blindId: 'b1',
  startStack: 30000,
  entryFee: 50000,
  rebuyUntil: 5,
  prizePayouts: [{ place: 1, percent: 100 }],
};

describe('CreateSessionBody — 파이프가 실제로 승격시키는 자리', () => {
  it('blindStructure 생략 + blindId 있음 → 통과한다', async () => {
    // 기존 구조를 재사용하는 정상 경로. 예전 파라미터 분리 방식에서는
    // `@IsOptional()`이 파라미터 레벨이라 걸리지 않아, 생략한 blindStructure가
    // `{}`로 승격되고 CreateBlindStructureDto의 필수 검사에 걸려 400이 났다.
    const value = { dto: validTournament };
    let threw: unknown = null;
    try {
      await pipe().transform(value, { type: 'body', metatype: CreateSessionBody } as any);
    } catch (e) {
      threw = e;
    }
    expect(`거부 ${threw ? '됨' : '안 됨'}`).toBe('거부 안 됨');
  });

  it('blindStructure가 채워져 있으면 통과한다', async () => {
    const value = {
      dto: { ...validTournament, blindId: undefined },
      blindStructure: {
        name: '기본 구조',
        storeId: 's1',
        structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
      },
    };
    let threw: unknown = null;
    try {
      await pipe().transform(value, { type: 'body', metatype: CreateSessionBody } as any);
    } catch (e) {
      threw = e;
    }
    expect(`거부 ${threw ? '됨' : '안 됨'}`).toBe('거부 안 됨');
  });

  it('blindStructure가 빈 객체면 거부한다', async () => {
    // 생략(undefined)과 빈 객체({})는 다른 요청이다. 후자는 상점이 blindStructure를
    // "보냈지만 속을 안 채운" 경우라 CreateBlindStructureDto의 필수 검사가
    // 그대로 걸려야 한다 — 여기서까지 통과시키면 봉투가 구멍이 된다.
    const value = { dto: validTournament, blindStructure: {} };
    let threw: unknown = null;
    try {
      await pipe().transform(value, { type: 'body', metatype: CreateSessionBody } as any);
    } catch (e) {
      threw = e;
    }
    expect(`거부 ${threw ? '됨' : '안 됨'}`).toBe('거부 됨');
  });
});
