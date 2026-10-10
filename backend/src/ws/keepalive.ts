/**
 * 좀비 소켓 청소(T96).
 *
 * 서버가 연결의 끝을 아는 길은 둘뿐이다 — 상대가 FIN/RST를 보내거나, 보낸
 * 데이터의 재전송이 끝내 실패하거나(리눅스 기본 15~30분). **말없이 사라지는**
 * 경로(와이파이 이탈 · 전원 차단 · 절전 · 공유기 재부팅 · 망 전환)에서는 앞의
 * 것이 안 오고, 보낼 것이 없으면 뒤의 것도 시작되지 않는다. 그 소켓은
 * `readyState === OPEN`인 채로 방에 남는다.
 *
 * 그래서 주기마다 ping을 보내고 **직전 틱 뒤로 pong이 없던 소켓을 끊는다.**
 * 브라우저는 ping에 pong을 자동으로 답한다 — 프론트가 할 일이 없다.
 *
 * 순수 모듈이다. 타이머도 게이트웨이도 모른다 — 그래야 "두 틱 뒤에 끊긴다"를
 * 실제로 기다리지 않고 잰다(`reconnect-policy.ts`·`turn-clock.ts`와 같은 이유).
 */

/** ping 주기. 서버의 판정 폭이 이 값의 1~2배다. */
export const SOCKET_PING_MS = 10_000;

export interface KeepaliveSocket {
  readyState: number;
  /** 직전 ping 뒤로 pong을 받았나. `markAlive`와 `sweep`만 쓴다. */
  isAlive?: boolean;
  /**
   * 마지막으로 응답한 시각(T121). 응답이 없어 끊을 때 「언제부터 끊겼나」의 근거다 —
   * 끊는 것은 그보다 한두 틱 뒤다. `markAlive`만 쓴다.
   */
  aliveAt?: number;
  /** 딜러 빠른 확인(T121)을 마지막으로 보낸 시각과, 그 뒤로 연달아 답이 없던 횟수. `probe`가 쓰고, 침묵하던 소켓이 답하면 `WsGateway.onPong`이 횟수를 0으로 되돌린다. */
  probeSentAt?: number;
  probeMisses?: number;
  ping(): void;
  terminate(): void;
  send(message: string): void;
}

const OPEN = 1;

/**
 * 테스트가 주기를 줄일 수 있게 한다. **줄이는 값만** 받는다 — 양의 정수가
 * 아니거나 `SOCKET_PING_MS`보다 크면 기본값으로 돌아간다. 이 환경 변수의
 * 용도는 테스트가 주기를 줄이는 것뿐이라, 늘린 값을 그대로 받으면 조용한
 * 테이블의 태블릿이 전부 `SOCKET_SILENCE_MS`(`use-table-socket.ts`)마다
 * 끊기고 다시 붙는다.
 */
export function socketPingMs(raw: string | undefined = process.env.WS_PING_INTERVAL_MS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= SOCKET_PING_MS ? n : SOCKET_PING_MS;
}

/**
 * 딜러 빠른 확인의 주기(T121). 딜러 소켓만 이 주기로 ping한다 — 테이블당 한 대라 싸다.
 *
 * 회선이 끊긴 대회는 그 대회의 딜러가 전부 침묵한 것으로 안다. 위 10초 주기로는 아는 데
 * 10~20초가 걸리고, 그 사이 마감이 온 사람이 접힌다(200테이블 실측 4~21명). 이 주기면
 * 4~6초다.
 */
export const DEALER_PROBE_MS = 2_000;
/** 연달아 이만큼 답이 없으면 침묵이다. 한 번은 이벤트 루프가 밀린 것일 수 있다. */
export const DEALER_SILENT_PROBES = 2;

/** `WS_DEALER_PROBE_MS` — 양의 정수만. 그 밖은 기본값. */
export function dealerProbeMs(raw: string | undefined = process.env.WS_DEALER_PROBE_MS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEALER_PROBE_MS;
}

/**
 * 빠른 확인 한 번. 직전 확인에 답했는지 세고 새 ping을 보낸다.
 *
 * **끊지 않는다.** 끊는 것은 `sweep`의 일이다 — 여기서 끊으면 와이파이가 몇 초 흔들린
 * 딜러가 40~50초 뒤에야 다시 붙는다(`reconnect-policy.ts`). 침묵인지만 말하고, 답이
 * 돌아오면 그 소켓 그대로 이어 간다.
 */
export function probe(socket: KeepaliveSocket, now = Date.now()) {
  if (socket.probeSentAt !== undefined) {
    const answered = (socket.aliveAt ?? 0) >= socket.probeSentAt;
    socket.probeMisses = answered ? 0 : (socket.probeMisses ?? 0) + 1;
  }
  socket.probeSentAt = now;
  try { socket.ping(); } catch { /* 닫히는 중이다. sweep이 치운다 */ }
}

/** 빠른 확인에 연달아 답이 없는가. */
export function isSilent(socket: KeepaliveSocket): boolean {
  return (socket.probeMisses ?? 0) >= DEALER_SILENT_PROBES;
}

/** 접속 직후와 pong을 받을 때 부른다. */
export function markAlive(socket: KeepaliveSocket, now = Date.now()) {
  socket.isAlive = true;
  socket.aliveAt = now;
}

/**
 * 한 틱. 답이 없던 소켓은 끊고, 나머지에는 ping과 앱 레벨 신호를 보낸다.
 *
 * **하나가 던져도 나머지를 돈다.** `WsGateway.broadcast`가 죽은 소켓 하나에
 * 루프를 멈추지 않는 것과 같은 이유다.
 *
 * @returns 끊은 소켓. 부르는 쪽이 방에서 뺀다.
 */
export function sweep(sockets: Iterable<KeepaliveSocket>, message: string): KeepaliveSocket[] {
  const dead: KeepaliveSocket[] = [];
  for (const s of sockets) {
    if (s.readyState !== OPEN || s.isAlive === false) {
      try { s.terminate(); } catch { /* 이미 닫혔다 */ }
      dead.push(s);
      continue;
    }
    try {
      s.isAlive = false;
      s.ping();
      s.send(message);
    } catch {
      try { s.terminate(); } catch { /* 이미 닫혔다 */ }
      dead.push(s);
    }
  }
  return dead;
}
