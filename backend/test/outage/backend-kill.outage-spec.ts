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

/**
 * T108 — **리바인 창이 열린 채 죽었다 살아난다**(10~14번).
 *
 * `resolveWinners`는 세 구간인데 가운데(리바인 대기)가 락 밖이고, 그동안 판이
 * 안 넘어가는 근거는 **메모리**다 — 호출 스택과 `rebuyInFlight` 표시. 프로세스가
 * 죽으면 둘 다 사라지고 **3단계(탈락 확정)는 한 번도 안 돈다.** 남는 것은
 * `HAND_END` 스냅샷과 탈락하지 않은 참가 행뿐이다.
 *
 * 티켓은 「테이블이 `HAND_END`에 갇힌다」였는데 **그게 아니었다.** 갇히지
 * 않는다 — `retryCheckpoint`는 페이즈만 보므로 딜러는 그대로 빠져나온다. 그
 * 길이 `finishHand` → `initTable`로 가고, `initTable`은 **스택 0인 사람을 좌석에서
 * 조용히 지운다.** 등수도 상금도 `activePlayers` 감소도 없이 사라지는 것이
 * 진짜 증상이었다.
 *
 * 단위의 증명은 `src/scenario/rebuy-restart.int-spec.ts`가 든다(거기는 재시작을
 * `DealerService`를 새로 지어 흉내 낸다). 여기가 더 재는 것은 **딜러가 나올 길이
 * 진짜로 열리는가**다 — 진짜 재시작 뒤에는 `SYNCING`과 부팅 스윕이 세운
 * `resumePending`이 앞을 막고 서 있고, 그 둘을 지나야 `RETRY_CHECKPOINT`에 닿는다.
 * 그 문들은 흉내 무대에 없다.
 *
 * **무대는 새로 짓지 않는다.** 위가 세운 같은 대회·같은 테이블을 이어서 쓴다 —
 * 시드가 대회를 둘밖에 안 깔고, 파일을 나누면 도는 순서가 보장되지 않는다.
 */
describe('실제 kill — 백엔드를 죽였다 살린다', () => {
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

  /* ---------------------------------------------------------------- *
   * T108 — 리바인 창이 열린 채 죽었다 살아난다. 위 무대를 이어서 쓴다.
   * ---------------------------------------------------------------- */

  /** 파산시킬 사람에게 남길 스택. 남들이 이 금액을 콜하면 그 사람만 0이 된다. */
  const BUST_STACK = 1_000;
  /** 지금 살아 있는 좌석 소켓. 같은 닉네임으로 다시 붙으면 덮는다. */
  const live = new Map<string, Sock>();
  let dealerSock: Sock;
  let bustNickname: string;
  let bustId: string;
  let bustSeat: number;
  let chipsAtBust: number;
  let activeBefore: number;

  async function until(pred: () => boolean | Promise<boolean>, ms: number, label: string) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await pred()) return;
      if (Date.now() > deadline) {
        // **못 기다린 이유가 화면에 남아야 한다.** 페이즈와 차례를 함께 찍지
        // 않으면 「안 됐다」만 보이고, 무대가 어디서 멈췄는지 다시 돌려야 안다.
        const s = await snapshot(tables[0].id).catch(() => null);
        throw new Error(
          `${label}: ${ms}ms 안에 안 됐다 (페이즈 ${s?.phase} 차례 ${s?.currentTurnSeatIndex}, error [${errors().join(' | ')}])`,
        );
      }
      await sleep(100);
    }
  }
  async function connectSeat(nickname: string) {
    const seat = seatTokens.find((s) => s.nickname === nickname)!;
    const sock = await connect(nickname, seat.token, seat.tableId);
    live.set(nickname, sock);
    return sock;
  }
  async function connectDealer(name: string) {
    const body = await http('POST', '/dealer/auth', { tournamentId, tableId: tables[0].id, otp: dealerOtp });
    dealerSock = await connect(name, body.accessToken ?? body.token, tables[0].id);
    return dealerSock;
  }
  async function participation(userId: string) {
    const { rows } = await db.query(
      'SELECT status, "finalPlace", "prizeAmount" FROM "TournamentParticipation" WHERE "tournamentId" = $1 AND "userId" = $2',
      [tournamentId, userId],
    );
    return rows[0] as { status: string; finalPlace: number | null; prizeAmount: number };
  }
  async function activePlayers(): Promise<number> {
    const { rows } = await db.query('SELECT "activePlayers" FROM "Tournament" WHERE id = $1', [tournamentId]);
    return Number(rows[0].activePlayers);
  }
  /** 좌석 비트맵에서 켜진 자리 수. 탈락이 확정되면 그 사람의 비트가 꺼진다. */
  async function seatBits(): Promise<number> {
    const map = await redis.hget(`tournament:${tournamentId}:seat`, `table:${tables[0].id}`);
    return (map ?? '').split('').filter((c) => c === '1').length;
  }

  /**
   * 차례인 사람이 `cap`까지 밀어 넣는다. 스택이 그보다 적으면 올인이고, 그 사람만
   * 파산한다 — 남들은 같은 금액을 내고도 스택이 남는다.
   */
  async function driveToShowdown(cap: number) {
    for (let guard = 0; guard < 30; guard++) {
      const s = await snapshot(tables[0].id);
      if (s.phase >= 5) return s;             // SHOWDOWN
      if (s.currentTurnSeatIndex === -1) return s;
      const me = s.players[s.currentTurnSeatIndex];
      const sock = live.get(me.nickname);
      if (!sock) throw new Error(`차례인 ${me.nickname}의 소켓이 없다`);
      const target = Math.min(me.stack + me.bet, cap);
      const action = target > s.currentBet ? 'RAISE' : 'CALL';
      send(sock, 'PLAYER_ACTION', { action, ...(action === 'RAISE' ? { amount: target } : {}) });
      await until(
        async () => {
          const n = await snapshot(tables[0].id);
          return n.phase !== s.phase || n.currentTurnSeatIndex !== s.currentTurnSeatIndex;
        },
        5_000, `10. ${me.nickname} ${action}`,
      );
    }
    throw new Error('10. 쇼다운까지 못 갔다');
  }

  /**
   * 파산자를 만들 무대를 세운다. 돌던 핸드를 딜러가 접어서 끝내고, **핸드
   * 경계에서** 한 사람의 스택만 줄인다 — 진행 중인 판을 건드리면 그 핸드의
   * 부기가 어긋나서, 뒤에서 빨개진 것이 제품 결함인지 무대 탓인지 안 갈린다.
   */
  it('10. 돌던 핸드를 끝내고, 다음 핸드에 파산할 사람을 만든다', async () => {
    dealerSock = sockets.find((s) => s.name === '딜러1-재접속')!;
    const before = await snapshot(tables[0].id);
    const seated = before.players.filter((p: any) => p != null);

    // **남길 사람은 victim이다.** 8번에서 이미 콜했으므로 `bet == currentBet`이고,
    // 그래야 나머지가 접힌 순간 엔진이 쇼다운으로 넘어간다 — 아직 안 낸 사람을
    // 남기면 그 사람의 액션을 영영 기다린다(그 좌석의 소켓은 재시작이 끊었다).
    for (const p of seated) {
      if (p.id === victimId) continue;
      send(dealerSock, 'DEALER_ACTION', { action: 'DEALER_FOLD', targetUserId: p.id });
      await sleep(300);
    }

    // 파산시킬 사람은 victim이 아닌 누구든 된다 — 11번이 좌석 전원의 소켓을
    // 다시 붙인다.
    const target = seated.find((p: any) => p.id !== victimId)!;
    bustNickname = target.nickname;
    bustId = target.id;
    bustSeat = before.players.findIndex((p: any) => p?.id === target.id);
    await until(async () => (await snapshot(tables[0].id)).phase === 5, 10_000, '10. 쇼다운');

    send(dealerSock, 'DEALER_ACTION', { action: 'RESOLVE_WINNERS', winnerGroups: [[victimId]] });
    await until(async () => (await snapshot(tables[0].id)).phase === 0, 15_000, '10. 다음 핸드 대기');

    // **핸드 경계다.** 여기서만 스냅샷을 직접 쓴다 — 아무도 차례가 아니고
    // 진행 중인 팟도 없다. 체크포인트가 다음 핸드 끝에 DB를 맞춘다.
    const waiting = await snapshot(tables[0].id);
    waiting.players[bustSeat].stack = BUST_STACK;
    await redis.set(`table:state:${tables[0].id}`, JSON.stringify(waiting));
    chipsAtBust = chipsOf(waiting);
    activeBefore = await activePlayers();

    expect(`10. 페이즈 ${waiting.phase} 파산자스택 ${waiting.players[bustSeat].stack} 인원 ${activeBefore} 비트 ${await seatBits()}`)
      .toBe(`10. 페이즈 0 파산자스택 ${BUST_STACK} 인원 4 비트 4`);
  });

  it('11. 판을 열어 한 사람을 파산시키고, 리바인 창이 열린 순간에 죽인다', async () => {
    for (const s of seatTokens) await connectSeat(s.nickname);

    send(dealerSock, 'DEALER_ACTION', { action: 'START_PRE_FLOP' });
    await until(async () => (await snapshot(tables[0].id)).phase === 1, 10_000, '11. 프리플랍');
    await driveToShowdown(BUST_STACK);

    const showdown = await snapshot(tables[0].id);
    const winner = showdown.players.find((p: any) => p != null && p.id !== bustId)!;
    const seat = live.get(bustNickname)!;
    const from = seat.inbox.length;

    // 이 호출은 **돌아오지 않는다.** 리바인 대기에서 붙잡혀 있는 동안 죽일 것이고,
    // 그 프로세스와 함께 사라지는 것이 이 검사의 대상이다.
    send(dealerSock, 'DEALER_ACTION', { action: 'RESOLVE_WINNERS', winnerGroups: [[winner.id]] });
    await waitFor(seat, from, (m) => m.event === 'REBUY_PROMPT', 20_000, '11. 리바인 팝업');

    const held = await snapshot(tables[0].id);
    const part = await participation(bustId);
    expect(`11. 페이즈 ${held.phase} 리바인표시 ${held.rebuyPending !== undefined} 파산자상태 ${part.status} 칩 ${chipsOf(held)}`)
      .toBe(`11. 페이즈 6 리바인표시 true 파산자상태 PLAYING 칩 ${chipsAtBust}`);

    killAt = Date.now();
    await stopBackend();
    live.clear();
    expect(`11. 포트 응답 ${await answersOnPort()}`).toBe('11. 포트 응답 false');
  });

  /**
   * **이 단계가 티켓의 질문이다** — 「딜러가 나올 길이 실제로 열리는가」.
   *
   * **무대가 전제를 하나 고쳤다.** 재시작한 테이블은 정지 표시가 서는 줄 알았는데
   * `HAND_END`에는 **차례가 없어서** 부팅 스윕이 그냥 지나간다(`planPause`는
   * 차례 주인이 없으면 `null`이다 — T94가 일부러 넣은 반대 입력이다). 그래서
   * 「이어서 진행」은 거절당하고, 문은 `RETRY_CHECKPOINT` 하나뿐이다. 그 거절을
   * 함께 재는 이유는 그것이 곧 「이 테이블은 정지가 아니라 **미완의 핸드**다」의
   * 증거라서다.
   *
   * 앞을 막는 것은 `SYNCING` 하나다 — 딜러가 다 돌아올 때까지 명령을 전부 거절한다.
   */
  it('12. 다시 띄우면 딜러가 체크포인트 재시도 하나로 빠져나온다', async () => {
    await startBackend();
    await connectDealer('딜러1-재시작');
    await until(async () => (await tournamentRow()).status === 'ONGOING', 20_000, '12. n/n 복귀');

    const held = await snapshot(tables[0].id);
    expect(`12. 페이즈 ${held.phase} 정지표시 ${held.resumePending !== undefined} 리바인표시 ${held.rebuyPending !== undefined}`)
      .toBe('12. 페이즈 6 정지표시 false 리바인표시 true');

    let from = dealerSock.inbox.length;
    send(dealerSock, 'DEALER_ACTION', { action: 'RESUME_TABLE' });
    const refused = await waitFor(dealerSock, from, (m) => m.event === 'error', 10_000, '12. 재개 거절');
    expect(`12. 재개 ${refused.data}`).toBe('12. 재개 멈춰 있는 테이블이 아닙니다.');

    from = dealerSock.inbox.length;
    send(dealerSock, 'DEALER_ACTION', { action: 'RETRY_CHECKPOINT' });
    const done = await waitFor(dealerSock, from, (m) => m.event === 'renderGame' && m.data.phase === 0, 15_000, '12. 체크포인트 재시도');
    expect(`12. 페이즈 ${done.data.phase} 리바인표시 ${done.data.rebuyPending !== undefined}`)
      .toBe('12. 페이즈 0 리바인표시 false');
  });

  /**
   * **좌석에서 사라진 것과 탈락이 확정된 것은 다르다.** `initTable`은 스택 0인
   * 사람을 그냥 지우므로, 스냅샷만 보면 둘이 똑같이 보인다. 가르는 것은 DB의
   * 등수·상금과 `activePlayers`, 그리고 좌석 비트맵이다.
   */
  it('13. 사라진 사람은 탈락으로 확정돼 있다 — 등수 · 인원 · 좌석 비트맵', async () => {
    const state = await snapshot(tables[0].id);
    const part = await participation(bustId);
    // 시드는 35엔트리라 기본 분배표의 상금권이 다섯이고, 넷째 자리는 그 안이다
    // — 그래서 `ELIMINATED`가 아니라 **상금을 받은** `AWARDED`가 정답이다.
    expect(`13. 좌석 ${state.players.some((p: any) => p?.id === bustId)} 상태 ${part.status} 등수 ${part.finalPlace} 상금 ${part.prizeAmount > 0} 인원 ${await activePlayers()} 비트 ${await seatBits()} 칩 ${chipsOf(state)}`)
      .toBe(`13. 좌석 false 상태 AWARDED 등수 ${activeBefore} 상금 true 인원 ${activeBefore - 1} 비트 ${activeBefore - 1} 칩 ${chipsAtBust}`);
  });

  /**
   * 나올 길이 진짜 열렸는가 — 다음 핸드가 실제로 돈다.
   *
   * **이 검사는 결함을 잡지 않는다. 일부러 그렇다.** 되돌려 보면 초록이다 —
   * 리바인 표시가 남아도, 탈락이 유실돼도 다음 핸드는 그대로 돈다. 잡는 것은
   * 12·13이고, 여기가 재는 것은 「12·13이 테이블을 못 쓰게 만들지 않았다」다.
   */
  it('14. 다음 핸드가 돈다', async () => {
    send(dealerSock, 'DEALER_ACTION', { action: 'START_PRE_FLOP' });
    await until(async () => (await snapshot(tables[0].id)).phase === 1, 10_000, '14. 프리플랍');
    const state = await snapshot(tables[0].id);
    expect(`14. 페이즈 ${state.phase} 착석 ${state.players.filter((p: any) => p != null).length} 칩 ${chipsOf(state)}`)
      .toBe(`14. 페이즈 1 착석 ${activeBefore - 1} 칩 ${chipsAtBust}`);
  });
});
