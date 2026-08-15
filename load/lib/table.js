import { WebSocket } from 'k6/experimental/websockets';
import { setTimeout, clearTimeout } from 'k6/timers';
import { Trend, Counter } from 'k6/metrics';
import {
  dealerLogin,
  enterSeat,
  joinTournament,
  login,
  myPlayerOtp,
  signup,
  wsTicket,
} from './api.js';

/**
 * VU 하나가 테이블 하나를 통째로 든다.
 *
 * **이것이 이 하네스의 핵심 결정이다.** 재려는 것 중 하나가 "남이 누른 액션이
 * 내 화면에 뜨기까지"인데, k6는 VU 사이에 상태를 공유하지 않는다
 * (`SharedArray`는 읽기 전용). VU를 사람 하나에 대응시키면 보낸 쪽과 받은 쪽이
 * 다른 VU라 시계를 맞출 수 없어 그 지연을 아예 잴 수 없다.
 *
 * 한 VU가 좌석 아홉 + 딜러 하나, 소켓 열 개를 들면 두 지연이 같은 시계 위에
 * 놓인다. 램프에서 테이블 100개는 VU 100개, 소켓 1,000개다.
 */

const GamePhase = {
  WAITING: 0,
  PRE_FLOP: 1,
  FLOP: 2,
  TURN: 3,
  RIVER: 4,
  SHOWDOWN: 5,
  HAND_END: 6,
};

/** 내가 누른 버튼이 내 화면에 반영되기까지. 합격선 p95 200ms. */
export const myActionMs = new Trend('my_action_ms', true);
/** 남이 누른 액션이 내 화면에 반영되기까지. 합격선 p95 500ms. */
export const othersActionMs = new Trend('others_action_ms', true);
/** 완주한 핸드 수. 봇이 실제로 게임을 돌렸는지의 증거다. */
export const handsPlayed = new Counter('hands_played');
/** 소켓이 서버에게 거절당한 횟수. 0이 아니면 그 실행의 지연 수치는 못 믿는다. */
export const socketErrors = new Counter('socket_errors');
/** 아예 누르지 않아 서버 타임아웃에 맡긴 횟수. 그 경로가 돌았다는 증거다. */
export const absentActions = new Counter('absent_actions');
/** 마감 직후에 눌러 마감 시각 판정을 밟은 횟수. */
export const lateActions = new Counter('late_actions');

/**
 * WS는 Origin 헤더가 필수다(`ws.gateway.ts`의 `assertAllowedOrigin`).
 * 브라우저가 아니라 봇이므로 직접 넣어 준다. 값은 컨테이너의
 * `WS_ALLOWED_ORIGINS`와 맞아야 한다.
 */
const ORIGIN = __ENV.WS_ORIGIN || 'http://localhost:3000';
const WS_BASE = __ENV.WS_URL || 'ws://127.0.0.1:3001';

/**
 * 사람이 생각하는 시간. **부하의 모양을 정하는 값이다.**
 *
 * 처음에는 고정 7초를 썼다. 시간당 27핸드 × 핸드당 20액션을 나눈 평균이
 * 테이블당 0.13액션/초라, 그 역수쯤이면 맞다고 본 것이다. **틀렸다.**
 * 이벤트 루프를 밀어붙이는 것은 평균이 아니라 몰림이고, 고정값은 부하를
 * 매끄럽게 펴서 순간 부하를 실제보다 작게 만든다.
 *
 * 실제 테이블에서 액션은 두 종류로 갈린다.
 *
 * - **거의 즉시** — 체크·폴드·콜. 낼 것이 정해져 있어 생각할 게 없다.
 *   연달아 몇 건이 몰린다.
 * - **오래** — 레이즈 사이즈, 큰 팟에서의 콜 판단. 20초를 넘기기도 한다.
 *   상한은 서버의 30초 타임아웃이다(`REBUY_TIMEOUT_MS`와 별개인 턴 타이머).
 *
 * 그래서 분포로 뽑는다. 상한 30초는 넘기지 않는다 — 넘기면 타임아웃 잡이
 * 대신 폴드시켜 봇의 액션이 사라지고, 그러면 재려던 지연도 사라진다.
 */
const THINK_FAST_MS = Number(__ENV.LOAD_THINK_FAST_MS || 2000);
const THINK_SLOW_MS = Number(__ENV.LOAD_THINK_SLOW_MS || 18000);
/** 오래 생각하는 액션의 비율. 나머지는 거의 즉시다. */
const THINK_SLOW_RATIO = Number(__ENV.LOAD_THINK_SLOW_RATIO || 0.15);

/**
 * 핸드 사이에 딜러가 쉬는 시간. **이걸 빼먹으면 테이블당 부하가 실제보다
 * 크게 나온다.**
 *
 * 카드는 물리다. 그동안 시스템은 아무것도 받지 않는다 — 이 리포의 전제
 * (카드는 물리, 칩은 디지털)가 부하 모양에도 그대로 나타나는 자리다.
 *
 * **팟을 미는 시간은 여기 없다.** 칩이 디지털이라 정산과 지급을 서버가
 * `resolveWinners`에서 끝낸다. 딜러에게 남는 물리 작업은 카드뿐이다.
 *
 *   카드 회수      3~5초
 *   셔플·컷        10~15초 — 딜러가 손으로 섞는다
 *   딜링 9인 2장   8~12초
 *
 * 합쳐 21~32초라 기본값을 25초로 둔다.
 */
const DEAL_MS = Number(__ENV.LOAD_DEAL_MS || 25000);

/**
 * 아예 누르지 않는 액션의 비율. **타임아웃 경로를 실제로 돌리려는 것이다.**
 *
 * 봇이 언제나 30초 안에 누르면 `TIME_OUT` 잡이 한 번도 돌지 않는다. 그런데
 * 그 경로는 BullMQ 큐 → 락 → 스냅샷 쓰기 → 브로드캐스트를 전부 쓰는 진짜
 * 부하이고, 실제 대회에는 자리를 비운 사람이 늘 있다. 안 돌리면 부하의 한
 * 갈래가 통째로 빠진다.
 */
const ABSENT_RATIO = Number(__ENV.LOAD_ABSENT_RATIO || 0.03);

/**
 * 마감 직후에 도착하는 액션의 비율.
 *
 * 30초를 아주 살짝 넘겨 누르는 사람이다. 타임아웃 잡이 이미 폴드시킨 뒤에
 * 도착하므로 **제품의 마감 시각 판정**(`playsync.service.ts:86` — "판정 기준은
 * 요청 도착 순서가 아니라 마감 시각이다")이 그때 처음 돈다. 봇이 이 경로를
 * 밟지 않으면 그 코드는 부하 중에 한 번도 실행되지 않는다.
 */
const LATE_RATIO = Number(__ENV.LOAD_LATE_RATIO || 0.02);
const LATE_MS = Number(__ENV.LOAD_LATE_MS || 30300);

/**
 * 이 액션을 언제(혹은 아예 안) 보낼지.
 *
 * @returns `null`이면 보내지 않는다 — 서버 타임아웃에 맡긴다.
 */
function thinkMs() {
  if (THINK_FAST_MS <= 0 && THINK_SLOW_MS <= 0) return 0;
  if (Math.random() < ABSENT_RATIO) return null;
  if (Math.random() < LATE_RATIO) return LATE_MS;

  const slow = Math.random() < THINK_SLOW_RATIO;
  const base = slow ? THINK_SLOW_MS : THINK_FAST_MS;
  // 같은 값이 겹치면 인위적인 동시 도착이 생긴다. 절반~1.5배로 흩는다.
  const jittered = base * (0.5 + Math.random());
  // 여기서는 30초를 넘기지 않는다. 넘기는 경우는 위 두 분기가 따로 만든다.
  return Math.min(Math.round(jittered), 29000);
}

/**
 * 신규 가입의 비율. **나머지는 이미 계정이 있는 손님이다.**
 *
 * 처음에는 좌석마다 가입 + 로그인을 둘 다 태웠다. 그러면 bcrypt가 사람당 두
 * 번(`hash` + `compare`) 돌아 실제의 두 배가 되고, 정원이 낮게 나온다.
 *
 * 실제 홀덤펍에서 대회 직전에 몰리는 것은 **로그인**이다. 손님 대부분은 계정이
 * 이미 있고 — 그 가입은 몇 주 전에 흩어져 일어났다 — 그날 새로 만드는 사람은
 * 첫 방문자 소수뿐이다. 그래서 계정은 시드가 풀로 만들어 두고, 봇은 이 비율
 * 만큼만 실행 중에 가입한다.
 */
const NEW_USER_RATIO = Number(__ENV.LOAD_NEW_USER_RATIO || 0.1);

/** 실행 중 가입한 수와 로그인 수. 비율이 의도대로 나왔는지 결과에서 본다. */
export const signups = new Counter('signups');
export const logins = new Counter('logins');

/**
 * 합법 액션 중에서 어떻게 고르나. **부하의 모양을 정하는 두 번째 값이다.**
 *
 * 원래는 콜만 했다. 근거는 "레이즈를 섞으면 스택이 빨리 갈려 램프 중간에
 * 테이블이 빈다"였는데, 무한 리바인이 인원을 유지하면서 그 근거가 사라졌다.
 *
 * | | 왜 이 액션이 필요한가 |
 * |---|---|
 * | 체크·콜 | 기본. 핸드가 끝까지 가야 플랍·턴·리버·쇼다운이 전부 돈다 |
 * | 레이즈 | `resetChecked()`가 돌아 라운드가 한 바퀴 더 간다(`table-engine.ts:333`). 액션 수가 늘고 fan-out이 그만큼 곱해진다 |
 * | 폴드 | 없으면 사이드팟이 안 생기고 팟이 늘 전원 분배다 |
 */
const RAISE_RATIO = Number(__ENV.LOAD_RAISE_RATIO || 0.2);
const FOLD_RATIO = Number(__ENV.LOAD_FOLD_RATIO || 0.15);

/** 리바인을 수락한 횟수. 리바인 경로가 실제로 돌았다는 증거다. */
export const rebuysAccepted = new Counter('rebuys_accepted');
/** 레이즈와 폴드 횟수. 믹스가 의도대로 나왔는지 결과에서 본다. */
export const raises = new Counter('raises');
export const folds = new Counter('folds');

/**
 * 이 상태에서 이 좌석이 낼 액션 하나.
 *
 * **합법인 것 중에서만 고른다.** 불법 액션은 엔진이 던지지만
 * (`table-engine.ts:55`의 "콜이 필요합니다"), 그 거절이 부하에 섞이면 재는
 * 것이 게임이 아니라 에러 경로가 된다.
 *
 * @param bigBlind 레이즈 단위. 시드 매니페스트의 값이다.
 */
function pickAction(state, me, bigBlind) {
  // 브로드캐스트 페이로드에 `currentBet`이 없으면(스키마가 바뀌면) 모든
  // 판정이 NaN이 되어 조용히 콜만 하게 된다. 없는 것을 0으로 접지 않고
  // 먼저 확인하는 이유는, 조용히 옛 동작으로 돌아가는 것이 가장 나쁜
  // 실패 모드이기 때문이다.
  if (typeof state.currentBet !== 'number') {
    throw new Error('renderGame에 currentBet이 없다 — 액션 믹스를 판정할 수 없다');
  }
  const toCall = state.currentBet - me.bet;
  const canCheck = toCall <= 0;
  // 레이즈는 `currentBet`보다 큰 목표 총액을 낼 수 있어야 성립한다.
  // 스택이 그에 못 미치면 레이즈를 빼고 콜(= 올인)로 접는다.
  const canRaise = me.stack + me.bet > state.currentBet;

  const r = Math.random();
  if (canRaise && r < RAISE_RATIO) {
    // **`amount`는 목표 총 베팅액이다.** 엔진이 보는 것은
    // `betAmount > currentBet` 하나뿐이고 최소 레이즈 규칙이 없다
    // (`table-engine.ts:321`). 스택을 넘으면 `executeBet`이 잘라 올인이
    // 되고, 그 자리가 사이드팟을 만든다 — 일부러 막지 않는다.
    const step = 1 + Math.floor(Math.random() * 3); // 1~3 BB
    const amount = state.currentBet + step * bigBlind;
    raises.add(1);
    return { action: 'RAISE', amount };
  }
  // 낼 것이 없는데 폴드하는 사람은 없다. 체크가 가능하면 체크다.
  if (!canCheck && r < RAISE_RATIO + FOLD_RATIO) {
    folds.add(1);
    return { action: 'FOLD' };
  }
  return canCheck ? { action: 'CHECK' } : { action: 'CALL' };
}

/**
 * 좌석을 채운다.
 *
 * @param poolBase 이 테이블이 쓸 풀 계정의 시작 인덱스. 램프에서 테이블끼리
 *   겹치면 `@@unique([tournamentId, userId])`가 두 번째를 409로 막는다.
 * @param prefix 신규 가입용 접두사. 닉네임은 3~10자다(`CreateUserDto`).
 */
export function seatPlayers({
  tournamentId,
  tableId,
  password,
  seatCount,
  prefix,
  poolBase,
  accountPrefix,
  accountPool,
}) {
  const players = [];
  for (let seat = 0; seat < seatCount; seat++) {
    const index = (poolBase || 0) + seat;
    // 풀이 모자라면 신규로 넘긴다 — 램프가 풀보다 커지면 조용히 겹치는 대신
    // 새로 만든다. 그 사실은 `signups` 카운터에 남는다.
    const fresh = Math.random() < NEW_USER_RATIO || index >= (accountPool || 0);

    let nickname;
    if (fresh) {
      // 좌석은 0~8이라 한 글자다. 닉네임 상한을 지키려고 붙여 쓴다.
      nickname = `${prefix}${seat.toString(36)}`;
      signup(nickname, password);
      signups.add(1);
    } else {
      nickname = `${accountPrefix}${String(index).padStart(4, '0')}`;
    }

    const token = login(nickname, password);
    logins.add(1);
    joinTournament(token, tournamentId);
    const otp = myPlayerOtp(token, tournamentId);
    const seatToken = enterSeat(tournamentId, otp, tableId, seat);
    players.push({ seat, nickname, seatToken });
  }
  return players;
}

/**
 * 소켓 열 개를 열고 정해진 시간 동안 핸드를 돌린다.
 *
 * 봇은 **게임 규칙을 지킨다.** 자기 차례일 때만 액션을 보내고, 딜러가 핸드를
 * 시작·종료시킨다. 마구 던지면 대부분 "차례 아님"으로 무시되는데
 * (`table-engine.ts:31`이 조용히 돌아간다), 그러면 올인·사이드팟 같은 비싼
 * 경로가 한 번도 안 돌아 최악 장부 경로를 못 본다.
 *
 * @returns 실행이 끝나면 resolve되는 Promise
 */
export function runHands({
  tournamentId,
  tableId,
  dealerOtp,
  players,
  durationMs,
  bigBlind,
  stepLabel,
}) {
  const dealerToken = dealerLogin(tournamentId, tableId, dealerOtp);

  // 티켓은 1회용이라 소켓마다 하나씩 받는다(T24 — Redis GETDEL로 소비된다).
  const seats = players.map((p) => ({
    ...p,
    ticket: wsTicket(p.seatToken),
  }));
  const dealerTicket = wsTicket(dealerToken);

  const sockets = [];
  /**
   * 진행 중인 액션들의 지연 측정 창. **큐여야 한다.**
   *
   * 처음에는 창을 하나만 두고 "열려 있으면 새 액션을 막는" 방식이었는데
   * 테이블이 멈췄다. 브로드캐스트 하나를 소켓 열 개가 각자 처리하는데, 그중
   * 세 번째 소켓이 "내 차례다"를 보고 액션을 보내려는 시점에는 아직 일곱이
   * 안 받아 창이 열려 있다 — 그래서 막혔고, 아무도 다시 두지 못했다.
   *
   * 큐로 두면 막을 이유가 없다. 소켓마다 **자기가 아직 못 본 가장 오래된
   * 창**에 기록하면 되고, 열 개가 다 본 창은 앞에서 걷어낸다.
   */
  const windows = []; // [{ at, actorSocketIdx, seen:Set }]
  let latestState = null;
  let closing = false;

  // 게이트웨이 경로는 `/playsync`다(`@WebSocketGateway({ path: '/playsync' })`).
  // 루트로 붙으면 핸드셰이크 이전에 거절돼 서버 로그에도 남지 않는다.
  function url(ticket) {
    return `${WS_BASE}/playsync?ticket=${ticket}&tableId=${tableId}`;
  }

  function open(ticket, role, seat) {
    const ws = new WebSocket(url(ticket), null, { headers: { Origin: ORIGIN } });
    const idx = sockets.length;
    // `scheduled`가 없으면 같은 소켓이 액션을 중복 예약한다. 자기 차례인
    // 동안에는 브로드캐스트가 올 때마다 `step`이 다시 불리기 때문이다.
    // 중복 액션은 서버가 "차례 아님"으로 무시하지만(`table-engine.ts:31`)
    // 브로드캐스트는 그대로 나가고, 그러면 창과 수신이 하나씩 어긋나
    // **생각 시간이 지연으로 잡힌다** — 실측에서 정확히 THINK_MS만큼 나왔다.
    const entry = { ws, role, seat, idx, userId: null, scheduled: false };
    sockets.push(entry);

    ws.onmessage = (msg) => {
      let parsed;
      try {
        parsed = JSON.parse(msg.data);
      } catch (e) {
        return;
      }
      // 리바인 팝업(`ws.gateway.ts:316`)은 좌석 하나에게만 간다. 즉시
      // 수락해 좌석이 비지 않게 한다 — 램프의 규모 축이 인원 감소로
      // 흔들리면 안 된다.
      //
      // `processRebuy`는 이 응답을 락 **밖에서** 최대 15초 기다리고
      // (`REBUY_TIMEOUT_MS`), 그동안 `HAND_END`가 다음 핸드를 막는다.
      // 즉시 답해도 왕복이 끼므로 핸드 주기가 늘어난다 — 실제 대회도 그렇다.
      if (parsed.event === 'REBUY_PROMPT') {
        rebuysAccepted.add(1);
        entry.ws.send(JSON.stringify({ event: 'REBUY_RESPONSE', data: { accept: true } }));
        return;
      }
      if (parsed.event !== 'renderGame' || !parsed.data) return;
      latestState = parsed.data;

      // 지연 기록 — 보낸 시각과 받은 시각이 같은 VU 안에 있다.
      const win = windows.find((w) => !w.seen.has(idx));
      if (win) {
        win.seen.add(idx);
        const elapsed = Date.now() - win.at;
        // 단계 태그가 붙어야 원시 시계열에서 "테이블 12개 구간"을 갈라
        // 볼 수 있다. 램프가 아니면(스모크) 라벨이 없다.
        const tags = stepLabel ? { step: stepLabel() } : undefined;
        if (idx === win.actorSocketIdx) myActionMs.add(elapsed, tags);
        else othersActionMs.add(elapsed, tags);
        while (windows.length > 0 && windows[0].seen.size >= sockets.length) {
          windows.shift();
        }
      }

      if (!closing) step(entry, parsed.data);
    };

    ws.onerror = () => {
      socketErrors.add(1);
    };

    // 정상 종료(1000)와 우리가 닫은 것은 세지 않는다. 그 외의 코드는 서버가
    // 거절한 것이고(1008 = 인증 실패), 그 실행의 지연 수치는 못 믿는다.
    ws.onclose = (e) => {
      if (closing) return;
      const code = e && e.code;
      if (code && code !== 1000) {
        socketErrors.add(1);
        console.error(`소켓 종료 code=${code} reason=${(e && e.reason) || ''}`);
      }
    };

    return entry;
  }

  /**
   * 액션 하나를 보내고 지연 측정 창을 연다.
   *
   * 생각 시간은 창을 열기 **전에** 기다린다. 기다린 시간이 지연으로 잡히면
   * 측정하려는 것이 서버가 아니라 봇의 게으름이 된다.
   */
  function send(entry, payload) {
    if (entry.scheduled) return;
    entry.scheduled = true;
    const fire = () => {
      entry.scheduled = false;
      if (closing) return;
      windows.push({ at: Date.now(), actorSocketIdx: entry.idx, seen: new Set() });
      entry.ws.send(JSON.stringify(payload));
    };
    const isDeal = entry.role === 'dealer' && payload.data.action === 'START_PRE_FLOP';
    const wait = isDeal ? DEAL_MS : thinkMs();

    // `null`은 "자리에 없다" — 아예 보내지 않고 서버 타임아웃에 맡긴다.
    // 예약 플래그는 풀어 둬야 다음 핸드에서 이 좌석이 다시 움직인다.
    if (wait === null) {
      absentActions.add(1);
      entry.scheduled = false;
      return;
    }
    if (wait >= LATE_MS) lateActions.add(1);

    if (wait > 0) setTimeout(fire, wait);
    else fire();
  }

  /**
   * 상태를 보고 이 소켓이 지금 할 일을 한다.
   *
   * 딜러는 대기 상태면 핸드를 시작하고, 쇼다운이면 승자를 넣는다. 좌석은
   * 자기 차례일 때만 콜한다.
   */
  function step(entry, state) {
    if (entry.role === 'dealer') {
      if (state.phase === GamePhase.WAITING || state.phase === GamePhase.HAND_END) {
        send(entry, { event: 'DEALER_ACTION', data: { action: 'START_PRE_FLOP' } });
        return;
      }
      if (state.phase === GamePhase.SHOWDOWN) {
        // **승자를 무작위 한 명으로 고른다.** 승자는 계산되는 값이 아니라
        // 딜러가 입력하는 값이므로(카드는 물리다) 봇이 카드를 못 봐도 이
        // 경로는 정당하다.
        //
        // 예전에는 폴드 안 한 전원을 한 그룹으로 넣었다(보드 하이). 그러면
        // 팟이 낸 만큼 되돌아와 **아무도 터지지 않고**, 리바인 분기
        // (`dealer.service.ts:309`)가 한 번도 실행되지 않는다.
        const alive = state.players.filter((p) => p && !p.hasFolded).map((p) => p.id);
        if (alive.length > 0) {
          const winner = alive[Math.floor(Math.random() * alive.length)];
          handsPlayed.add(1);
          send(entry, {
            event: 'DEALER_ACTION',
            data: { action: 'RESOLVE_WINNERS', winnerGroups: [[winner]] },
          });
        }
      }
      return;
    }

    // 좌석 — 자기 차례가 아니면 아무것도 하지 않는다.
    const me = state.players[entry.seat];
    if (!me) return;
    if (entry.userId === null) entry.userId = me.id;
    if (state.currentTurnSeatIndex !== entry.seat) return;
    if (me.hasFolded || me.isAllIn) return;

    // 합법 액션 중에서 고른다. 콜만 하면 팟이 늘 전원에게 되돌아와
    // 탈락이 없고, 그러면 리바인·사이드팟 경로가 통째로 안 돈다.
    send(entry, { event: 'PLAYER_ACTION', data: pickAction(state, me, bigBlind) });
  }

  seats.forEach((s) => open(s.ticket, 'seat', s.seat));
  const dealer = open(dealerTicket, 'dealer', -1);

  // 첫 핸드는 스스로 시작한다. 접속 직후 받는 renderGame이 WAITING이면
  // `step`이 시작시키지만, 소켓이 붙기 전에 상태가 바뀌면 아무도 안 민다.
  const kick = setTimeout(() => {
    if (latestState && latestState.phase === GamePhase.WAITING) {
      send(dealer, { event: 'DEALER_ACTION', data: { action: 'START_PRE_FLOP' } });
    }
  }, 1000);

  return new Promise((resolve) => {
    setTimeout(() => {
      closing = true;
      clearTimeout(kick);
      sockets.forEach((s) => {
        try {
          s.ws.close();
        } catch (e) {
          // 이미 닫힌 소켓. 정리 중이라 무시한다.
        }
      });
      resolve();
    }, durationMs);
  });
}
