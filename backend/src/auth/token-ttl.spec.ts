import { JwtService } from '@nestjs/jwt';
import { Role, TournamentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DealerService } from 'src/dealer/dealer.service';
import { EntryService } from 'src/entry/entry.service';
import { AuthService } from './auth.service';
import { SEAT_ROLE } from './seat-role';
import { tokenTtl } from './token-ttl';

/**
 * 토큰 수명이 역할마다 다른가.
 *
 * **전역 1시간 하나였고 대회 길이를 못 버텼다**(T43). 좌석 토큰이
 * `POST /ws/ticket`에 쓰이므로 한 시간이 지나면 태블릿이 스스로 재접속하지
 * 못한다 — 네 시간짜리 대회면 전원이 겪는다.
 *
 * 재는 것은 **서명된 토큰의 `exp - iat`**이다. 상수를 읽어 비교하면 상수가
 * 상수와 같다는 것만 확인하게 된다. `JwtService`도 진짜를 쓰되 모듈 기본값을
 * 결함 당시와 같은 전역 1시간으로 두어, 서명 지점이 수명을 넘기지 않으면
 * 그 기본값이 그대로 나오게 한다.
 */

const HOUR = 3600;
const secret = 'test-only-not-a-real-secret';

/** 서명된 토큰의 실제 수명(시간). */
function ttlHours(token: string): number {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  );
  return (payload.exp - payload.iat) / HOUR;
}

const jwt = () => new JwtService({ secret, signOptions: { expiresIn: '1h' } });

describe('토큰 수명', () => {
  describe('tokenTtl', () => {
    it.each([
      [SEAT_ROLE, '12h'],
      [Role.DEALER, '12h'],
      [Role.STORE_ADMIN, '12h'],
      [Role.USER, '1h'],
      [Role.PLATFORM_ADMIN, '1h'],
    ])('%s는 %s', (role, expected) => {
      expect(`${role} ${tokenTtl(role)}`).toBe(`${role} ${expected}`);
    });
  });

  /**
   * 상수가 옳아도 **서명할 때 넘기지 않으면** 전역 기본값이 그대로 나간다.
   * 그것이 T43의 결함이었으므로 서명 지점을 하나씩 본다.
   */
  describe('서명 지점이 실제로 그 수명을 싣는다', () => {
    it('좌석 토큰은 12시간이다', async () => {
      const service = new EntryService(
        {
          tournamentParticipation: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'p-1',
              userId: 'user-1',
              currentStack: 10000,
              status: 'PLAYING',
              user: { nickname: 'alice' },
              tournament: { status: TournamentStatus.ONGOING },
            }),
          },
          tablePlayer: { findFirst: jest.fn().mockResolvedValue(null) },
        } as any,
        {} as any,
        jwt(),
        { emit: jest.fn() } as any,
      );
      // 좌석 확정 자체는 T28·T29가 이미 검증한다. 여기서 보는 것은 그 뒤에
      // 나가는 토큰이라, 락·트랜잭션을 흉내 내는 대신 건너뛴다.
      jest.spyOn(service as any, 'claimSeat').mockResolvedValue(undefined);

      const { accessToken } = await service.enterSeat('tournament-1', {
        otp: '123456',
        tableId: 'table-1',
        seatIndex: 0,
      } as any);

      expect(`좌석 ${ttlHours(accessToken)}시간`).toBe('좌석 12시간');
    });

    it('상점 관리자 로그인은 12시간, 일반 유저는 1시간이다', async () => {
      const password = await bcrypt.hash('pw', 4);
      const login = (role: Role) =>
        new AuthService(
          {} as any,
          { findByNickname: jest.fn().mockResolvedValue({ id: 'u', nickname: 'n', role, password }) } as any,
          jwt(),
        ).login({ nickname: 'n', password: 'pw' } as any);

      const owner = await login(Role.STORE_ADMIN);
      const user = await login(Role.USER);

      expect(`상점 ${ttlHours(owner.accessToken)}시간`).toBe('상점 12시간');
      expect(`유저 ${ttlHours(user.accessToken)}시간`).toBe('유저 1시간');
    });

    it('딜러 갱신 토큰도 12시간이다', async () => {
      const service = new DealerService(
        {} as any,
        {
          dealerSession: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'ds-1',
              tournamentId: 't-1',
              tokenVersion: 3,
              tournament: { status: TournamentStatus.ONGOING },
              tables: [{ id: 'table-1' }],
            }),
          },
        } as any,
        {} as any,
        {} as any,
        jwt(),
        {} as any,
      );

      const { accessToken } = await service.refreshToken({
        sub: 'ds-1',
        tournamentId: 't-1',
        tableId: 'table-1',
        tokenVersion: 3,
      });

      expect(`딜러 ${ttlHours(accessToken)}시간`).toBe('딜러 12시간');
    });
  });
});
