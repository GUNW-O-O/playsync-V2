import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { Client } from 'pg';
import WebSocket from 'ws';
import { SERVER_OUTAGE_EVENT, SERVER_RECOVERING_MESSAGE } from '@playsync/contract';
import { BACKEND_PORT, OUTAGE_ENV, REDIS_CONTAINER, ROOT_MANIFEST } from './global-teardown';

/**
 * T97 — 백엔드는 살려 두고 **Redis 컨테이너를 실제로 죽였다 살린다.**
 *
 * 시나리오 계층(`redis-outage.int-spec.ts`)은 ioredis를 `disconnect`로 끊는다.
 * 여기는 그 흉내가 닿지 않는 것을 본다 — 진짜 TCP가 끊기는 모양, BullMQ 워커가
 * 돌아와 밀린 타임아웃 잡을 실제로 흘리는 순서, 빌드한 백엔드 한 벌의 조립.
 *
 * 사람이 돌린다. CI에 없다. 판정은 단계마다 값을 문자열로 감싸 실패 메시지에
 * 단계 이름이 남게 한다.
 */

const BASE = `http://127.0.0.1:${BACKEND_PORT}`;
const ORIGIN = 'http://localhost:3000';
const REJECT_AT_MS = 3_000;
const DOWN_MS = 30_000;
const OBSERVE_MS = 40_000;
const PRE_FLOP = 1;
const SHOWDOWN = 5;

type Msg = { at: number; event: string; data: any };
type Sock = { name: string; ws: WebSocket; inbox: Msg[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

async function http<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text as T;
  }
}

describe('T97 실제 kill — Redis 컨테이너가 죽었다 살아도 차례였던 사람은 폴드되지 않는다', () => {
  const sockets: Sock[] = [];
  const db = new Client({ connectionString: OUTAGE_ENV.DATABASE_URL });

  let tournamentId: string;
  let startStack: number;
  let seatTokens: { nickname: string; tableId: string; token: string }[] = [];
  let tables: { id: string; tableOrder: number }[];
  let dealerOtp: string;
  let dealer1: Sock;
  let initialChips: number;
  let victimId: string;
  let victimSock: Sock;
  let killAt: number;
  let upAt: number;

  beforeAll(async () => { await db.connect(); });

  afterAll(async () => {
    for (const s of sockets) s.ws.terminate();
    await db.end();
    // 중간 단계가 실패해 컨테이너가 죽은 채 남으면 KEEP_OUTAGE_CONTAINERS로
    // 다시 돌릴 때 셋업이 반쯤 선 무대를 받는다. `start`는 살아 있으면 아무 일도 안 한다.
    try { execSync(`docker start ${REDIS_CONTAINER}`, { stdio: 'ignore' }); } catch { /* 이미 내려갔다 */ }
  });

  function seatOf(nickname: string) {
    const s = sockets.find((x) => x.name === nickname);
    if (!s) throw new Error(`소켓 없음: ${nickname}`);
    return s;
  }

  function send(s: Sock, event: string, data: unknown) {
    s.ws.send(JSON.stringify({ event, data }));
  }

  /** 모든 소켓이 받은 `error`. 기다리던 것이 안 오면 이유가 대개 여기 있다. */
  function errors() {
    return sockets.flatMap((s) => s.inbox.filter((m) => m.event === 'error').map((m) => `${s.name}: ${m.data}`));
  }

  async function waitFor(s: Sock, from: number, pred: (m: Msg) => boolean, ms: number, label: string) {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = s.inbox.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        const got = s.inbox.slice(from).map((m) => m.event).join(',');
        throw new Error(`${label}: ${ms}ms 안에 오지 않았다 (${s.name} 받은 것 [${got}], error [${errors().join(' | ')}])`);
      }
      await sleep(20);
    }
  }

  const chipsOf = (state: any) =>
    state.players.reduce((sum: number, p: any) => sum + (p?.stack ?? 0), 0) + state.pot;

  async function connect(name: string, token: string, tableId: string) {
    const { ticket } = await http<{ ticket: string }>('POST', '/ws/ticket', undefined, token);
    const ws = new WebSocket(`ws://127.0.0.1:${BACKEND_PORT}/playsync?ticket=${ticket}&tableId=${tableId}`, {
      headers: { Origin: ORIGIN },
    });
    const sock: Sock = { name, ws, inbox: [] };
    ws.on('message', (raw) => {
      const { event, data } = JSON.parse(raw.toString());
      sock.inbox.push({ at: Date.now(), event, data });
    });
    ws.on('close', (code) => sock.inbox.push({ at: Date.now(), event: '__close', data: code }));
    sockets.push(sock);
    // 게이트웨이가 접속자에게 renderGame을 한 번 보낸다 — 그것이 「열렸고 등록됐다」의 증거다.
    await waitFor(sock, 0, (m) => m.event === 'renderGame', 10_000, `2. ${name} 첫 프레임`);
    return sock;
  }

  async function tournamentRow() {
    const { rows } = await db.query('SELECT status, "pausedMs" FROM "Tournament" WHERE id = $1', [tournamentId]);
    return rows[0] as { status: string; pausedMs: number };
  }

  it('1. 테이블 1에 넷, 테이블 2에 셋을 앉히고 대회를 시작한다', async () => {
    const m = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8'));
    tournamentId = m.tournament.id;
    startStack = m.tournament.startStack;
    dealerOtp = m.dealerOtp;
    tables = [...m.tables].sort((a, b) => a.tableOrder - b.tableOrder);
    expect(`1. 결제한 참가자 ${m.players.length}`).toBe('1. 결제한 참가자 7');

    const layout = m.players.map((p: { nickname: string; otp: string }, i: number) => ({
      ...p,
      table: i < 4 ? tables[0] : tables[1],
      seatIndex: i < 4 ? i : i - 4,
    }));
    for (const p of layout) {
      const body = await http('POST', `/tournaments/${tournamentId}/enter`, {
        otp: p.otp,
        tableId: p.table.id,
        seatIndex: p.seatIndex,
      });
      seatTokens.push({ nickname: p.nickname, tableId: p.table.id, token: body.accessToken });
    }

    const owner = await http('POST', '/auth/login', { nickname: 'owner', password: m.password });
    await http('PATCH', `/store/sessions/${tournamentId}/start`, undefined, owner.accessToken);
    expect(`1. 시작 뒤 status ${(await tournamentRow()).status}`).toBe('1. 시작 뒤 status ONGOING');
  });

  it('2. 좌석 일곱 · 딜러 둘이 소켓으로 붙는다', async () => {
    // n/n은 **착석한 테이블마다** 딜러가 있어야 찬다 — 테이블 2에도 붙인다.
    for (const [i, table] of tables.slice(0, 2).entries()) {
      const body = await http('POST', '/dealer/auth', { tournamentId, tableId: table.id, otp: dealerOtp });
      const token = body.accessToken ?? body.dealerToken ?? body.token;
      const sock = await connect(`딜러${i + 1}`, token, table.id);
      if (i === 0) dealer1 = sock;
    }
    for (const seat of seatTokens) await connect(seat.nickname, seat.token, seat.tableId);
    expect(`2. 소켓 ${sockets.length}`).toBe('2. 소켓 9');
  });

  it('3. 판을 열고 한 명이 콜 — 다음 차례를 victim으로 잡는다', async () => {
    let from = dealer1.inbox.length;
    send(dealer1, 'DEALER_ACTION', { action: 'START_PRE_FLOP' });
    const pre = await waitFor(dealer1, from, (m) => m.event === 'renderGame' && m.data.phase === PRE_FLOP, 5_000, '3. 프리플랍');
    initialChips = chipsOf(pre.data);
    expect(`3. 칩 ${initialChips}`).toBe(`3. 칩 ${startStack * 4}`);

    const first = pre.data.players[pre.data.currentTurnSeatIndex];
    from = dealer1.inbox.length;
    send(seatOf(first.nickname), 'PLAYER_ACTION', { action: 'CALL' });
    const after = await waitFor(
      dealer1,
      from,
      (m) => m.event === 'renderGame' && m.data.currentTurnSeatIndex !== first.seatIndex,
      5_000,
      `3. ${first.nickname} 콜`,
    );
    const victim = after.data.players[after.data.currentTurnSeatIndex];
    victimId = victim.id;
    victimSock = seatOf(victim.nickname);
    expect(`3. victim 폴드 ${victim.hasFolded} 마감 ${typeof after.data.actionDeadline}`).toBe('3. victim 폴드 false 마감 number');
  });

  it('4. Redis 컨테이너를 죽인다', () => {
    killAt = Date.now();
    execSync(`docker kill ${REDIS_CONTAINER}`, { stdio: 'ignore' });
  });

  it('5. 장애 중 victim의 콜은 1초 안에 한국어 문구로 거절된다', async () => {
    await sleepUntil(killAt + REJECT_AT_MS);
    const from = victimSock.inbox.length;
    const sentAt = Date.now();
    send(victimSock, 'PLAYER_ACTION', { action: 'CALL' });
    const err = await waitFor(victimSock, from, (m) => m.event === 'error', 1_000, '5. 즉시 거절');
    expect(`5. 거절 문구 ${err.data}`).toBe(`5. 거절 문구 ${SERVER_RECOVERING_MESSAGE}`);
    console.log(`[5] 거절까지 ${err.at - sentAt}ms`);
  });

  it('6. 좌석 · 딜러 전원이 serverOutage {down:true}를 받았다', () => {
    const missing = sockets
      .filter((s) => !s.inbox.some((m) => m.at >= killAt && m.event === SERVER_OUTAGE_EVENT && m.data.down === true))
      .map((s) => s.name);
    expect(`6. down 못 받은 소켓 [${missing.join(',')}]`).toBe('6. down 못 받은 소켓 []');
  });

  it('7. 장애 중 DB의 대회는 SYNCING이다', async () => {
    expect(`7. status ${(await tournamentRow()).status}`).toBe('7. status SYNCING');
  });

  it('8. 30초 뒤 Redis를 되살린다', async () => {
    await sleepUntil(killAt + DOWN_MS);
    execSync(`docker start ${REDIS_CONTAINER}`, { stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      let pong = '';
      try {
        pong = execSync(`docker exec ${REDIS_CONTAINER} redis-cli -a ${OUTAGE_ENV.REDIS_PASSWORD} ping`, {
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
      } catch { /* 아직 안 떴다 */ }
      if (pong.includes('PONG')) break;
      if (Date.now() > deadline) throw new Error('8. Redis가 30초 안에 PONG을 안 했다');
      await sleep(200);
    }
    upAt = Date.now();
    console.log(`[8] 죽은 시간 ${upAt - killAt}ms`);
  });

  it('9. 40초 동안 victim은 폴드되지 않고, 복구 알림과 resumePending을 받는다', async () => {
    await sleepUntil(upAt + OBSERVE_MS);

    // 폴드를 먼저 본다 — 이 검사가 잡으려는 결함이 그것이다.
    const folded = victimSock.inbox.filter(
      (m) => m.at >= killAt && m.event === 'renderGame' && m.data.players.find((p: any) => p?.id === victimId)?.hasFolded,
    );
    expect(`9. victim 폴드 renderGame ${folded.length}`).toBe('9. victim 폴드 renderGame 0');

    const missing = sockets
      .filter((s) => !s.inbox.some((m) => m.at >= upAt && m.event === SERVER_OUTAGE_EVENT && m.data.down === false))
      .map((s) => s.name);
    expect(`9. up 못 받은 소켓 [${missing.join(',')}]`).toBe('9. up 못 받은 소켓 []');

    const last = victimSock.inbox.filter((m) => m.event === 'renderGame').at(-1)!;
    expect(`9. 마지막 renderGame resumePending ${last.data.resumePending ? '있음' : '없음'}`).toBe(
      '9. 마지막 renderGame resumePending 있음',
    );
    console.log(`[9] resumePending.downMs ${last.data.resumePending.downMs}`);
  });

  it('10. 딜러가 붙어 있으니 대회는 ONGOING으로 돌아오고 pausedMs가 25~40초다', async () => {
    const row = await tournamentRow();
    expect(`10. status ${row.status}`).toBe('10. status ONGOING');
    const inRange = row.pausedMs >= 25_000 && row.pausedMs <= 40_000;
    expect(`10. pausedMs ${row.pausedMs} 25~40초 ${inRange}`).toBe(`10. pausedMs ${row.pausedMs} 25~40초 true`);
    console.log(`[10] pausedMs ${row.pausedMs}`);
  });

  it('11. 딜러가 재개하고 핸드를 쇼다운까지 돌려 정산한다 — 칩 총량이 처음과 같다', async () => {
    let from = dealer1.inbox.length;
    send(dealer1, 'DEALER_ACTION', { action: 'RESUME_TABLE' });
    let state = (
      await waitFor(dealer1, from, (m) => m.event === 'renderGame' && !m.data.resumePending, 5_000, '11. 재개')
    ).data;

    for (let step = 0; state.phase < SHOWDOWN; step++) {
      if (step > 40) throw new Error('11. 40번 눌러도 쇼다운에 안 닿았다');
      const turn = state.players[state.currentTurnSeatIndex];
      const action = turn.bet === state.currentBet ? 'CHECK' : 'CALL';
      const label = `11. ${turn.nickname} ${action}`;
      const prev = state;
      from = dealer1.inbox.length;
      send(seatOf(turn.nickname), 'PLAYER_ACTION', { action });
      state = (
        await waitFor(
          dealer1,
          from,
          (m) => m.event === 'renderGame' && (m.data.phase !== prev.phase || m.data.currentTurnSeatIndex !== prev.currentTurnSeatIndex),
          5_000,
          label,
        )
      ).data;
      expect(`${label} 칩 ${chipsOf(state)}`).toBe(`${label} 칩 ${initialChips}`);
    }

    from = dealer1.inbox.length;
    send(dealer1, 'DEALER_ACTION', { action: 'RESOLVE_WINNERS', winnerGroups: [[victimId]] });
    const settled = await waitFor(
      dealer1,
      from,
      (m) => m.event === 'renderGame' && m.data.phase !== SHOWDOWN,
      10_000,
      '11. 승자 결정',
    );
    expect(`11. 정산 뒤 칩 ${chipsOf(settled.data)} 팟 ${settled.data.pot}`).toBe(`11. 정산 뒤 칩 ${initialChips} 팟 0`);
  });

  it('12. 소켓을 모두 닫는다', async () => {
    for (const s of sockets) s.ws.close();
    await sleep(500);
    const open = sockets.filter((s) => s.ws.readyState !== WebSocket.CLOSED).map((s) => s.name);
    expect(`12. 안 닫힌 소켓 [${open.join(',')}]`).toBe('12. 안 닫힌 소켓 []');
  });
});
