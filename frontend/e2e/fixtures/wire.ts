import { APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { BACKEND_URL, bearer } from './backstage';

/**
 * **카메라 밖에서 소켓을 잡는 손.**
 *
 * `backstage.ts`가 REST로 하는 일을 WebSocket으로도 해야 하는 이유는 하나다 —
 * 플레이어 액션과 딜러 명령에는 REST 경로가 없다. 게이트웨이가 유일한
 * 입구다(`ws.gateway.ts`의 `PLAYER_ACTION` · `DEALER_ACTION`).
 *
 * 정산 촬영은 테이블 넷을 도는데 화면은 넷뿐이다(`surfaces.ts`). 찍지 않는
 * 테이블 셋도 **진짜로 판을 돌려야** 필드가 줄어든 것이 진짜가 된다 —
 * 참가 행을 손으로 `ELIMINATED`로 바꾸면 화면에 뜨는 상금과 순위는 촬영이
 * 지어낸 값이 된다. 그래서 여기서 소켓을 연다.
 *
 * **브라우저 컨텍스트로 열지 않는 이유**는 비용이다. 녹화 없는 컨텍스트라도
 * 페이지 하나가 수십 MB인데, 여기서 필요한 것은 소켓 하나뿐이다. 노드의
 * `ws`는 소켓 하나가 소켓 하나다 — 서른다섯을 열어도 브라우저 하나보다 싸다.
 *
 * 몇 개까지 브라우저로 버티는지는 기계마다 다르므로 **그때 재서 판단한다.**
 * 다만 이 선택은 그 값과 무관하다 — 배경 좌석은 **그릴 필요가 없어서** 여기
 * 있는 것이지, 못 그려서가 아니다.
 *
 * ── 이 파일이 우회로가 아닌 것
 *
 * 여기서 여는 연결은 **좌석 태블릿이 여는 것과 같은 연결이다.** 티켓을
 * 발급받아(`POST /ws/ticket`) 핸드셰이크에 싣고, 게이트웨이의
 * `assertTableAccess`가 스냅샷에서 그 좌석을 찾는다 — 앉지 않은 사람은 여기서도
 * 붙지 못한다. 액션도 `PlayerActionSchema`를 그대로 지나간다. 다른 것은
 * **화면이 없다**는 것뿐이다.
 *
 * **`Origin`을 붙인다.** 게이트웨이는 헤더가 없는 접속을 통과시키지 않는다 —
 * `assertAllowedOrigin`이 `!origin`도 거부한다. 부하 하네스도 같은 이유로
 * 같은 값을 싣는다(`load/lib/table.js`). 헤더를 붙이는 것이 우회가 아니라
 * **브라우저와 같은 조건으로 맞추는 일**이다.
 */

/**
 * 핸드셰이크에 싣는 출처. 백엔드의 `WS_ALLOWED_ORIGINS`와 맞아야 한다.
 *
 * 기본값이 개발용 프론트라(`allowedOrigins()`), 촬영이 붙는 곳과 같다.
 */
const WS_ORIGIN = process.env.WS_ORIGIN ?? 'http://localhost:3000';

/** 하나의 소켓. 좌석 하나이거나 딜러 하나다. */
export type Wire = {
  /** 누구의 소켓인지. 실패 메시지에만 쓴다. */
  label: string;
  send(event: string, data: unknown): void;
  /**
   * 이 소켓에 도착한 이벤트를 기다린다.
   *
   * **이미 지나간 것도 잡는다** — 도착한 이벤트를 버리지 않고 쌓아 두기
   * 때문이다. 리바인 요청(`REBUY_PROMPT`)이 특히 그렇다: 서버가 탈락
   * 순간에 보내고 15초를 세는데, 부르는 쪽이 그 뒤에 기다리기 시작하면
   * `waitForEvent` 방식으로는 영영 못 잡는다.
   */
  waitFor(event: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
};

/**
 * 티켓을 받아 소켓 하나를 연다. **첫 프레임까지 기다린다.**
 *
 * 게이트웨이는 테이블에 붙은 소켓에게 `renderGame`을 자기에게만 한 번
 * 보낸다(`handleConnection`). 그 프레임이 도착했다는 것은 열렸고 그 테이블
 * 세션에 **등록까지 됐다**는 뜻이다 — `open` 이벤트보다 강한 신호이고,
 * 데모 스펙의 `watchSocket`이 브라우저 쪽에서 보는 것과 같은 신호다.
 *
 * 기다리지 않으면 곧바로 보낸 액션이 등록 전에 도착해 조용히 사라진다.
 */
export async function openWire(
  request: APIRequestContext,
  opts: { accessToken: string; tableId: string; label: string },
): Promise<Wire> {
  const res = await request.post(`${BACKEND_URL}/ws/ticket`, {
    headers: bearer(opts.accessToken),
  });
  if (!res.ok()) {
    throw new Error(`티켓 발급 실패 (${opts.label}): ${res.status()} ${await res.text()}`);
  }
  const { ticket } = (await res.json()) as { ticket: string };

  const url = `${BACKEND_URL.replace('http', 'ws')}/playsync?tableId=${opts.tableId}&ticket=${ticket}`;
  const socket = new WebSocket(url, { headers: { Origin: WS_ORIGIN } });

  /** 도착한 이벤트. 버리지 않는 이유는 `waitFor`의 주석에 있다. */
  const inbox: { event: string; data: unknown }[] = [];
  socket.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)) as { event: string; data: unknown });
    } catch {
      // 게이트웨이는 JSON만 보낸다. 아닌 것이 오면 그건 이 촬영의 관심사가
      // 아니라 게이트웨이의 결함이고, 여기서 삼켜도 다음 단언이 잡는다.
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`소켓이 안 열린다 (${opts.label})`)),
      30_000,
    );
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`소켓 오류 (${opts.label}): ${err.message}`));
    });
    // 인증 실패는 `close(1008)`로 온다. `error`로 오지 않으므로 따로 본다 —
    // 아니면 30초를 기다린 끝에 "안 열린다"라는 엉뚱한 원인이 남는다.
    socket.on('close', (code) => {
      if (code === 1008) {
        clearTimeout(timer);
        reject(new Error(`소켓 인증 실패 (${opts.label})`));
      }
    });
    socket.on('message', function first() {
      clearTimeout(timer);
      socket.off('message', first);
      resolve();
    });
  });

  return {
    label: opts.label,
    send(event, data) {
      socket.send(JSON.stringify({ event, data }));
    },
    async waitFor(event, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = inbox.findIndex((m) => m.event === event);
        if (hit >= 0) return inbox.splice(hit, 1)[0].data;
        if (Date.now() > deadline) {
          throw new Error(`${opts.label}: ${event}이 ${timeoutMs}ms 안에 오지 않았다.`);
        }
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    async close() {
      socket.close();
    },
  };
}

/**
 * 딜러 하나의 토큰. 화면 없이 그 테이블의 딜러가 된다.
 *
 * **테이블마다 따로 받는다.** OTP는 대회 하나에 하나지만 토큰은 `tableId`를
 * 서명해 넣으므로(`loginDealer`), 넷을 돌리려면 넷을 받아야 한다. 그것이 곧
 * A테이블 딜러가 B테이블을 못 만지는 이유다(T66).
 */
export async function dealerToken(
  request: APIRequestContext,
  opts: { tournamentId: string; tableId: string; otp: string },
): Promise<string> {
  const res = await request.post(`${BACKEND_URL}/dealer/auth`, {
    data: { tournamentId: opts.tournamentId, tableId: opts.tableId, otp: opts.otp },
  });
  if (!res.ok()) {
    throw new Error(`딜러 인증 실패 (${opts.tableId}): ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`딜러 응답에 accessToken이 없다 (${opts.tableId})`);
  return body.accessToken;
}
