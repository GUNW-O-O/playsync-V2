import { GameType } from '@prisma/client';
import { CreateTournamentDto } from 'shared/dto/tournament.dto';
import { SessionService } from './session.service';

/**
 * 세션 생성 시 블라인드 연결.
 *
 * Tournament.blindId는 BlindStructure를 가리키는 FK다. 그런데 생성 경로에는
 * "기존 블라인드를 재사용"(dto.blindId)과 "새로 만들어 붙임"(blindStructure)
 * 두 갈래가 있고, 둘 다 선택 인자다 — 즉 아무것도 안 넘기는 호출이 타입상
 * 합법이다. 그 경우 무엇을 저장할지가 이 테스트의 대상이다.
 *
 * DB가 없어도 검증할 수 있는 이유는, 올바른 동작이 "거부"이기 때문이다.
 * FK 위반을 DB에게 물어보는 게 아니라 애초에 트랜잭션까지 가지 않아야 한다.
 */
describe('SessionService.createSession', () => {
  const baseDto = (): CreateTournamentDto => ({
    name: '테스트 토너먼트',
    type: GameType.TOURNAMENT,
    storeId: 'store-1',
    startStack: 30000,
    entryFee: 10000,
    rebuyUntil: 5,
    itmCount: 3,
    isRegistrationOpen: true,
  });

  const setup = () => {
    const tournamentCreate = jest.fn().mockResolvedValue({ id: 'tournament-1' });
    const blindCreate = jest.fn().mockResolvedValue({ id: 'blind-new' });

    const tx = {
      tournament: {
        create: tournamentCreate,
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'tournament-1', tables: [{ id: 'table-1' }] }),
      },
      dealerSession: { create: jest.fn().mockResolvedValue({ id: 'dealer-1' }) },
      table: { create: jest.fn().mockResolvedValue({ id: 'table-1' }) },
    };

    const prisma = {
      blindStructure: { create: blindCreate },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const redis = { setSeatBitmap: jest.fn().mockResolvedValue(undefined) };

    const service = new SessionService(prisma as any, redis as any);
    return { service, prisma, redis, tournamentCreate, blindCreate };
  };

  const blindStructure = () => ({
    name: '기본 구조',
    storeId: 'store-1',
    structure: [{ lv: 1, sb: 100, ante: false, duration: 20 }],
  });

  it('기존 블라인드 id를 넘기면 그대로 연결한다', async () => {
    const { service, tournamentCreate } = setup();

    await service.createSession({ ...baseDto(), blindId: 'blind-existing' });

    expect(tournamentCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-existing');
  });

  it('블라인드 구조를 넘기면 새로 만들어 연결한다', async () => {
    const { service, tournamentCreate, blindCreate } = setup();

    await service.createSession(baseDto(), blindStructure());

    expect(blindCreate).toHaveBeenCalledTimes(1);
    expect(tournamentCreate.mock.calls[0][0].data.blindId).toBe('blind-new');
  });

  it('블라인드 정보가 아예 없으면 생성을 거부한다', async () => {
    // 거부하지 않으면 자리 채우기용 기본값이 그대로 FK로 저장된다. 운이 좋으면
    // 외래키 에러로 즉시 죽고, 운이 나쁘면 생성은 성공한 뒤 startSession의
    // game.blindStructure.structure 접근에서 죽는다 — 참가자가 다 앉은 다음에.
    const { service, prisma, tournamentCreate } = setup();

    await expect(service.createSession(baseDto())).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tournamentCreate).not.toHaveBeenCalled();
  });
});
