import { readFileSync } from 'fs';
import { Client } from 'pg';
import Redis from 'ioredis';
import WebSocket from 'ws';
import {
  BACKEND_PORT,
  OUTAGE_ENV,
  ROOT_MANIFEST,
  answersOnPort,
  startBackend,
  stopBackend,
} from './global-teardown';

/**
 * T107 — **백엔드 프로세스를 실제로 죽였다 살린다.**
 *
 * `redis-kill.outage-spec.ts`는 백엔드를 살려 둔 채 Redis만 죽인다. 그 무대가
 * 못 만드는 것이 다섯이다 — 소켓이 안 끊기고, 프로세스가 안 죽고, 부팅 훅이 안
 * 돌고, 하트비트가 안 멈추고, 메모리가 안 사라진다. 여기는 그 다섯을 한꺼번에
 * 만들고 **셋**을 본다(나머지 둘은 잔여 목록에 남긴다).
 *
 * 1. **살아남은 BullMQ 잡이 진짜로 발화한다.** 잡은 Redis에 산다 — 백엔드가
 *    죽어도 남고, 부팅 뒤 지연이 지나 터진다. 지금 T94의 검사는 `recoverAll()`을
 *    직접 부르고 세대만 보므로 **잡이 실제로 발화하는 자리가 없다.**
 * 2. **부팅 복구가 실제로 돈다.** 지금은 전부 `recoverAll()`을 손으로 부른다 —
 *    Nest가 그것을 부르는지, 포트가 열릴 때 이미 끝나 있는지를 아무도 안 본다.
 * 3. **하트비트가 진짜 다운타임을 준다.** 지금은 전부 손으로 심는다
 *    (`setHeartbeatAgo`). 실제 주기는 5초라 그게 곧 오차 상한이다.
 *
 * **막는 것이 둘이라는 것도 여기서 드러났다.** 1을 되돌려 보니 세대(`timerEpoch`)를
 * 안 올려도, 정지 표시(`resumePending`)를 안 세워도 각각 혼자서 폴드를 막는다 —
 * 둘 다 없애야 사람이 접힌다. T94가 「폴드 경로가 둘이었다」고 적은 것의 짝이다.
 *
 * 사람이 돌린다. CI에 없다. 판정은 단계마다 값을 문자열로 감싸 실패 메시지에
 * 단계 이름이 남게 한다.
 */

const BASE = `http://127.0.0.1:${BACKEND_PORT}`;
const ORIGIN = 'http://localhost:3000';
/** 턴 마감(`TURN_TIMEOUT_MS`). 살아남은 잡은 차례가 생긴 시각 + 이 값에 터진다. */
const TURN_TIMEOUT_MS = 30_000;
/** 하트비트 주기(`HeartbeatService.DEFAULT_INTERVAL_MS`) — 정지 시간 오차의 상한이다. */
const HEARTBEAT_MS = 5_000;
/** 죽여 두는 시간. 하트비트 주기보다 넉넉히 길어야 오차가 값에 묻히지 않는다. */
const DOWN_MS = 15_000;
const PRE_FLOP = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

type Msg = { at: number; event: string; data: any };
type Sock = { name: string; ws: WebSocket; inbox: Msg[] };

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
  try { return JSON.parse(text); } catch { return text as T; }
}

describe('T107 실제 kill — 백엔드가 죽었다 살아도 차례였던 사람은 폴드되지 않는다', () => {
  const sockets: Sock[] = [];
  const db = new Client({ connectionString: OUTAGE_ENV.DATABASE_URL });
  const redis = new Redis({
    host: OUTAGE_ENV.REDIS_HOST,
    port: Number(OUTAGE_ENV.REDIS_PORT),
    password: OUTAGE_ENV.REDIS_PASSWORD,
  });

  let manifest: any;
  let tournamentId: string;
  let startStack: number;
  let tables: { id: string; tableOrder: number }[];
  let seatTokens: { nickname: string; tableId: string; token: string }[] = [];
  let dealerOtp: string;

  let initialChips: number;
  let victimId: string;
  let victimNickname: string;
  /** 차례가 생긴 시각. 살아남은 잡은 여기 + `TURN_TIMEOUT_MS`에 터진다. */
  let turnAt: number;
  let staleJobId: string;
  let killAt: number;
  let upAt: number;
  let beatBeforeKill: number;
  let pausedMsBefore: number;
  let resumedAt: number;

  beforeAll(async () => { await db.connect(); });

  afterAll(async () => {
    for (const s of sockets) s.ws.terminate();
    await db.end();
    redis.disconnect();
    // 중간 단계가 실패해 백엔드가 죽은 채 남으면, 다음 실행의 셋업이 반쯤 선
    // 무대를 받는다. 이미 떠 있으면 아무 일도 안 한다.
    if (!(await answersOnPort())) {
      await startBackend().catch(() => { /* 정리 중이라 못 띄워도 넘어간다 */ });
    }
  });

  function send(s: Sock, event: string, data: unknown) {
    s.ws.send(JSON.stringify({ event, data }));
  }
  function seatOf(nickname: string) {
    const s = sockets.find((x) => x.name === nickname);
    if (!s) throw new Error(`소켓 없음: ${nickname}`);
    return s;
  }
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
    await waitFor(sock, 0, (m) => m.event === 'renderGame', 10_000, `${name} 첫 프레임`);
    return sock;
  }

  async function tournamentRow() {
    const { rows } = await db.query(
      'SELECT status, "pausedMs" FROM "Tournament" WHERE id = $1', [tournamentId],
    );
    return rows[0] as { status: string; pausedMs: number };
  }
  /**
   * 마지막 하트비트를 **epoch ms로** 읽는다.
   *
   * `beatAt`은 `timestamp`(타임존 없음)라, 행을 그대로 받아 `new Date(...)`로
   * 감싸면 node-pg가 **로컬 시각으로** 해석한다 — KST에서는 9시간이 통째로
   * 어긋나고, 그 값으로 계산한 경계는 3,200만 ms짜리 헛것이 된다(실제로
   * 그렇게 빨개졌다). DB 쪽에서 epoch로 바꿔 받으면 해석이 낄 자리가 없다.
   */
  async function heartbeatAt(): Promise<number> {
    const { rows } = await db.query(
      'SELECT EXTRACT(EPOCH FROM "beatAt") * 1000 AS ms FROM "ServerHeartbeat" WHERE id = $1',
      ['singleton'],
    );
    return Number(rows[0].ms);
  }
  const snapshot = async (tableId: string) =>
    JSON.parse((await redis.get(`table:state:${tableId}`))!);

  it('1. 좌석 넷을 앉히고 대회를 시작한다', async () => {
    // **두 번째 대회(`settlement`)를 쓴다.** 시드는 대회를 둘 깔고,
    // `redis-kill.outage-spec.ts`가 첫 번째를 쓴다 — 무대는 하나고 스펙은
    // 순서대로 도므로(`maxWorkers: 1`), 같은 대회를 쓰면 먼저 도는 쪽이
    // 나중 쪽의 전제를 무너뜨린다.
    const root = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8'));
    manifest = root.settlement;
    tournamentId = manifest.tournament.id;
    startStack = manifest.tournament.startStack;
    dealerOtp = manifest.dealerOtp;
    tables = [...manifest.tables].sort((a: any, b: any) => a.tableOrder - b.tableOrder);

    // 테이블 하나에 넷만 앉힌다 — 이 검사는 n/n 재집계가 아니라 부팅 경로를
    // 본다. 착석한 테이블이 하나면 딜러도 하나라 복귀 조건이 단순해진다.
    const mine = manifest.players
      .filter((x: any) => x.tableOrder === tables[0].tableOrder)
      .slice(0, 4);
    expect(`1. 앉힐 사람 ${mine.length}`).toBe('1. 앉힐 사람 4');
    for (const [i, p] of mine.entries()) {
      const body = await http('POST', `/tournaments/${tournamentId}/enter`, {
        otp: p.otp, tableId: tables[0].id, seatIndex: i,
      });
      seatTokens.push({ nickname: p.nickname, tableId: tables[0].id, token: body.accessToken });
    }
    const owner = await http('POST', '/auth/login', { nickname: 'owner', password: root.password });
    await http('PATCH', `/store/sessions/${tournamentId}/start`, undefined, owner.accessToken);

    const row = await tournamentRow();
    pausedMsBefore = row.pausedMs;
    expect(`1. status ${row.status}`).toBe('1. status ONGOING');
  });

  it('2. 딜러와 좌석이 붙고, 판을 열어 차례를 만든다', async () => {
    const body = await http('POST', '/dealer/auth', { tournamentId, tableId: tables[0].id, otp: dealerOtp });
    const dealer = await connect('딜러1', body.accessToken ?? body.token, tables[0].id);
    for (const seat of seatTokens) await connect(seat.nickname, seat.token, seat.tableId);

    const from = dealer.inbox.length;
    send(dealer, 'DEALER_ACTION', { action: 'START_PRE_FLOP' });
    const pre = await waitFor(dealer, from, (m) => m.event === 'renderGame' && m.data.phase === PRE_FLOP, 5_000, '2. 프리플랍');
    turnAt = Date.now();
    initialChips = chipsOf(pre.data);

    const victim = pre.data.players[pre.data.currentTurnSeatIndex];
    victimId = victim.id;
    victimNickname = victim.nickname;

    // **큐에 잡이 실제로 들어갔다.** 이 줄이 없으면 아래 「폴드 안 됨」이
    // 「잡이 애초에 없었다」로도 통과한다 — 이 검사의 전제를 여기서 못 박는다.
    const state = await snapshot(tables[0].id);
    staleJobId = `${tables[0].id}-${state.timerEpoch}`;
    const job = await redis.exists(`bull:player-timeout:${staleJobId}`);
    expect(`2. 칩 ${initialChips} 큐의잡 ${job} 마감 ${typeof state.actionDeadline}`)
      .toBe(`2. 칩 ${startStack * 4} 큐의잡 1 마감 number`);
  });

  it('3. 백엔드를 죽인다 — 전 단말의 소켓이 끊긴다', async () => {
    beatBeforeKill = await heartbeatAt();
    killAt = Date.now();
    // **읽은 하트비트가 제정신인가부터 본다.** 이 값이 어긋나면 아래 9번의
    // 경계가 통째로 헛것이 된다 — 그때 빨개지는 자리가 9번이면 원인이 안
    // 읽힌다(실제로 타임존 때문에 9시간이 어긋나 그렇게 됐다). 주기가 5초라
    // 마지막 하트비트는 언제나 그 안쪽이다.
    const age = killAt - beatBeforeKill;
    expect(`3. 하트비트 나이 ${age}ms 제정신 ${age >= 0 && age <= HEARTBEAT_MS * 3}`)
      .toBe(`3. 하트비트 나이 ${age}ms 제정신 true`);

    await stopBackend();

    for (const s of sockets) {
      await waitFor(s, 0, (m) => m.event === '__close', 5_000, `3. ${s.name} 끊김`);
    }
    expect(`3. 포트 응답 ${await answersOnPort()}`).toBe('3. 포트 응답 false');
  });

  it('4. 죽어 있는 동안 하트비트가 멈춘다', async () => {
    await sleepUntil(killAt + DOWN_MS);
    expect(`4. 하트비트 갱신됨 ${(await heartbeatAt()) > beatBeforeKill}`).toBe('4. 하트비트 갱신됨 false');
  });

  /**
   * **중점 2 — 다만 이 검사가 증명하는 것은 「순서」가 아니다.**
   *
   * 원래 재려던 것은 「`app.listen()`이 `onApplicationBootstrap`을 기다린다」였다.
   * `await this.boot`를 지워 봤더니 **그대로 초록이었다** — 이 무대의 복구는
   * 빨라서, 안 기다려도 포트가 열릴 때쯤 이미 끝나 있다. 순서를 진짜로 재려면
   * 복구를 느리게 만들어야 하는데 그건 제품을 건드리는 일이다.
   *
   * 그래서 이 검사가 잡는 것은 **「부팅 복구가 아예 안 돌았다」**다 —
   * `recoverAll`을 no-op으로 만들면 여기서 `ONGOING` · 정지표시 false · 살아
   * 있는 마감이 나오고, 7번에서 실제로 사람이 접힌다. 그 값이 크다.
   */
  it('5. 다시 띄운다 — 포트가 열린 첫 순간에 이미 복구가 끝나 있다', async () => {
    upAt = await startBackend();

    const row = await tournamentRow();
    const state = await snapshot(tables[0].id);
    expect(`5. status ${row.status} 정지표시 ${state.resumePending !== undefined} 마감 ${state.actionDeadline}`)
      .toBe('5. status SYNCING 정지표시 true 마감 undefined');
    console.log(`[5] 죽은 시간 ${upAt - killAt}ms`);
  });

  /**
   * **중점 3의 앞쪽 — 부팅은 아직 안 민다.**
   *
   * 보정의 자리는 부팅이 아니라 `completeSync`다(T96). 딜러가 다 돌아오기
   * 전에 밀면, 아직 깜깜한 테이블의 블라인드가 먼저 올라간다. 이 줄이 없으면
   * 아래 9번이 「어디서 늘었든」 통과한다.
   */
  it('6. 부팅만으로는 pausedMs가 안 는다 — 보정은 completeSync의 몫이다', async () => {
    const { pausedMs } = await tournamentRow();
    expect(`6. 부팅 뒤 더해진 정지 ${pausedMs - pausedMsBefore}ms`).toBe('6. 부팅 뒤 더해진 정지 0ms');
  });

  /**
   * **중점 1.** 잡은 Redis에 살아남아 부팅 뒤에 터진다. 부팅이 올린 세대가
   * 그것을 무효로 만들지 않으면 **차례였던 사람이 접힌다** — T94가 닫은 결함
   * 그대로인데, 잡이 실제로 발화하는 무대가 지금까지 없었다.
   */
  it('7. 살아남은 잡이 발화해도 victim은 폴드되지 않는다', async () => {
    // 잡의 마감이 지나고 워커가 집어 갈 시간까지 기다린다.
    await sleepUntil(turnAt + TURN_TIMEOUT_MS + 8_000);

    const state = await snapshot(tables[0].id);
    const victim = state.players.find((p: any) => p?.id === victimId);
    const gone = await redis.exists(`bull:player-timeout:${staleJobId}`);
    expect(`7. victim폴드 ${victim.hasFolded} 칩 ${chipsOf(state)} 옛잡 ${gone} 정지표시 ${state.resumePending !== undefined}`)
      .toBe(`7. victim폴드 false 칩 ${initialChips} 옛잡 0 정지표시 true`);
  });

  /**
   * **폴드 안 됨이 「차례가 살아 있다」는 뜻인가.** 딜러가 돌아와 재개하면 그
   * 사람이 실제로 행동할 수 있어야 한다 — 그래야 위 검사가 「아무도 아무것도
   * 못 하는 상태로 굳었다」와 구별된다.
   */
  it('8. 딜러가 돌아와 재개하면 victim이 그대로 행동한다', async () => {
    const body = await http('POST', '/dealer/auth', { tournamentId, tableId: tables[0].id, otp: dealerOtp });
    const dealer = await connect('딜러1-재접속', body.accessToken ?? body.token, tables[0].id);
    await sleep(1_000);   // n/n → completeSync → ONGOING

    resumedAt = Date.now();
    expect(`8. status ${(await tournamentRow()).status}`).toBe('8. status ONGOING');

    let from = dealer.inbox.length;
    send(dealer, 'DEALER_ACTION', { action: 'RESUME_TABLE' });
    await waitFor(dealer, from, (m) => m.event === 'renderGame' && m.data.resumePending === undefined, 10_000, '8. 재개');

    const seat = await connect(victimNickname, seatTokens.find((s) => s.nickname === victimNickname)!.token, tables[0].id);
    from = dealer.inbox.length;
    send(seat, 'PLAYER_ACTION', { action: 'CALL' });
    const acted = await waitFor(
      dealer, from,
      (m) => m.event === 'renderGame' && m.data.players.find((p: any) => p?.id === victimId)?.bet > 0,
      5_000, '8. victim 콜',
    );
    expect(`8. victim폴드 ${acted.data.players.find((p: any) => p?.id === victimId).hasFolded} 칩 ${chipsOf(acted.data)}`)
      .toBe(`8. victim폴드 false 칩 ${initialChips}`);
  });

  /**
   * **중점 3.** 정지 시간의 출처는 **마지막 하트비트**다 — 프로세스가 언제
   * 죽었는지는 아무도 안 적어 주므로 그 하트비트가 유일한 증거다.
   *
   * 아래쪽 경계는 「포트가 열린 시각 − 마지막 하트비트」다. 그보다 짧으면
   * 공백을 덜 센 것이다. 위쪽은 「`completeSync`가 돈 시각 − 마지막 하트비트」
   * + 여유 — 보정이 그 시점에 한 번 밀기 때문이다.
   *
   * **하트비트 주기(5초)가 곧 오차의 정체다.** 죽기 직전 최대 한 주기 전에
   * 찍혔으므로 실제 죽은 시간보다 그만큼 길게 잡힌다. 여기서는 그 하트비트를
   * 직접 읽어 뒀으므로 추측하지 않고 잰다.
   */
  it('9. completeSync가 마지막 하트비트부터의 공백만큼 pausedMs를 민다', async () => {
    const { pausedMs } = await tournamentRow();
    const added = pausedMs - pausedMsBefore;
    // **넓은 범위로 재면 안 된다.** 처음에 `[포트 열림 − 하트비트, 재개 −
    // 하트비트]`로 뒀더니, 7번의 긴 대기가 재개 시각을 멀리 밀어 **하트비트를
    // 아예 안 쓰는 구현도 그 범위 안에** 들어왔다. 기준점을 하나로 좁힌다 —
    // 「마지막 하트비트부터 재개까지」이고, 그 밖은 전부 틀린 것이다.
    const expected = resumedAt - beatBeforeKill;
    const off = Math.abs(added - expected);
    expect(`9. 더해진 정지 ${added}ms 기대 ${expected}ms 차이 ${off}ms 안쪽 ${off <= 4_000}`)
      .toBe(`9. 더해진 정지 ${added}ms 기대 ${expected}ms 차이 ${off}ms 안쪽 true`);
    const real = upAt - killAt;
    console.log(`[9] 실제 죽은 시간 ${real}ms, 하트비트 오차 ${(upAt - beatBeforeKill) - real}ms (주기 ${HEARTBEAT_MS}ms)`);
  });
});
