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
  ping(): void;
  terminate(): void;
  send(message: string): void;
}

const OPEN = 1;

/** 테스트가 주기를 줄일 수 있게 한다. 양의 정수가 아니면 기본값이다. */
export function socketPingMs(raw: string | undefined = process.env.WS_PING_INTERVAL_MS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SOCKET_PING_MS;
}

/** 접속 직후와 pong을 받을 때 부른다. */
export function markAlive(socket: KeepaliveSocket) {
  socket.isAlive = true;
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
