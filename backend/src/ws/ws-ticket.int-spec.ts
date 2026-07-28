import { Role } from '@prisma/client';
import Redis from 'ioredis';
import { createTestRedis, flushTestRedis } from '../../test/helpers/redis';
import { TICKET_TTL_SECONDS, WsTicketService } from './ws-ticket.service';

/**
 * 티켓의 수명과 1회용 보장.
 *
 * Redis가 진짜라야 의미가 있다 — 1회용은 `GETDEL`의 원자성에 걸려 있고,
 * mock으로 바꾸면 검증 대상 자체가 사라진다.
 */
describe('WsTicketService', () => {
  let redis: Redis;
  let tickets: WsTicketService;

  const identity = {
    sub: 'dealer-session-1',
    role: Role.DEALER,
    tournamentId: 'trnmt-1',
    tableId: 'tbl-1',
  };

  beforeAll(() => {
    redis = createTestRedis();
    tickets = new WsTicketService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  it('발급한 티켓으로 신원을 되찾는다', async () => {
    const ticket = await tickets.issue(identity);

    expect(await tickets.consume(ticket)).toEqual(identity);
  });

  it('같은 티켓은 두 번 쓰이지 않는다', async () => {
    const ticket = await tickets.issue(identity);

    expect(await tickets.consume(ticket)).toEqual(identity);
    expect(await tickets.consume(ticket)).toBeNull();
  });

  it('동시에 두 번 소비하면 하나만 신원을 받는다', async () => {
    // 읽고-지우는 두 명령으로 나누면 그 사이에 창이 생겨 둘 다 통과한다.
    // GETDEL이 원자적이라 창이 없다.
    const ticket = await tickets.issue(identity);

    const [a, b] = await Promise.all([tickets.consume(ticket), tickets.consume(ticket)]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('존재하지 않는 티켓은 null이다', async () => {
    expect(await tickets.consume('no-such-ticket')).toBeNull();
  });

  it('티켓에 30초 만료가 걸린다', async () => {
    // 만료를 기다리는 대신 TTL을 직접 본다. 30초를 실제로 기다리는 테스트는
    // 스위트를 못 쓰게 만든다.
    const ticket = await tickets.issue(identity);

    const ttl = await redis.ttl(`ws:ticket:${ticket}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TICKET_TTL_SECONDS);
  });

  it('만료된 티켓은 소비되지 않는다', async () => {
    const ticket = await tickets.issue(identity);
    await redis.pexpire(`ws:ticket:${ticket}`, 1);
    await new Promise((r) => setTimeout(r, 30));

    expect(await tickets.consume(ticket)).toBeNull();
  });

  it('티켓 값에서 신원을 역산할 수 없다', async () => {
    // 티켓이 신원을 인코딩한 값이면 로그에 남은 티켓만으로 누구인지 알 수 있다.
    const ticket = await tickets.issue(identity);

    expect(ticket).not.toContain(identity.sub);
    expect(ticket).not.toContain(identity.tableId);
  });
});
