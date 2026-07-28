import { Inject, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export const TICKET_TTL_SECONDS = 30;

/**
 * 티켓 하나가 담는 신원.
 *
 * 게이트웨이가 실제로 읽는 값 그대로다. 여기에 없는 것은 게이트웨이도 모른다 —
 * 티켓 소비가 곧 인증이므로, 이 타입이 WS 경계의 신원 정의다.
 */
export type WsIdentity = {
  sub: string;
  role: Role;
  tournamentId?: string;
  tableId?: string;
};

/**
 * WS 핸드셰이크용 단명 티켓.
 *
 * 액세스 토큰을 브라우저 JS에 내려보내지 않기 위해 존재한다. 토큰은 Next의
 * 서버 쪽(route handler)에만 있고, 브라우저에는 이 티켓만 간다. 로그나 페이지
 * 소스에 티켓이 남아도 이미 소비됐거나 30초 뒤 사라진다.
 */
@Injectable()
export class WsTicketService {
  // RedisService는 ioredis 인스턴스를 private으로 감추고 있어 밖에서 명령을
  // 직접 부를 수 없다. 티켓은 RedisService의 도메인 메서드(스냅샷·좌석 비트맵)와
  // 성격이 다르므로 그쪽에 메서드를 늘리지 않고 같은 토큰을 직접 주입한다.
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  private key(ticket: string) {
    return `ws:ticket:${ticket}`;
  }

  async issue(identity: WsIdentity): Promise<string> {
    // 티켓 값 자체는 신원을 인코딩하지 않는다. 로그에 남은 티켓만으로 누구인지
    // 알 수 있으면 안 된다.
    const ticket = randomUUID();
    await this.redis.set(this.key(ticket), JSON.stringify(identity), 'EX', TICKET_TTL_SECONDS);
    return ticket;
  }

  /**
   * 티켓을 소비하고 신원을 돌려준다. 없거나 이미 쓰였으면 `null`.
   *
   * `GETDEL`이 1회용의 근거다. 읽고 지우는 두 명령으로 나누면 그 사이에 창이
   * 생겨 같은 티켓으로 둘이 붙을 수 있다.
   */
  async consume(ticket: string): Promise<WsIdentity | null> {
    const raw = await this.redis.getdel(this.key(ticket));
    if (!raw) return null;
    return JSON.parse(raw) as WsIdentity;
  }
}
