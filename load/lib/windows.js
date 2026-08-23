/**
 * 지연 측정 창 큐.
 *
 * **순수 모듈이다** — 소켓도, 시계도, k6도 모른다. 그래서 테스트가 붙는다
 * (`windows.spec.js`). 이 로직은 원래 `table.js`의 `runHands` 클로저 안에
 * 있었고, 그래서 12,000명 실측에서 틀린 값을 내고도 아무도 못 잡았다(T76).
 *
 * ## 무엇을 재는가
 *
 * "내가 누른 버튼이 내 화면에 반영되기까지". 액션을 보낼 때 창을 열고
 * (`open`), 그 테이블의 브로드캐스트가 도착하면 창을 닫는다(`match`).
 * 소켓 열 개가 같은 브로드캐스트를 각자 받으므로 창 하나를 열 개가 본다.
 *
 * ## 왜 큐인가
 *
 * 창을 하나만 두고 "열려 있으면 새 액션을 막는" 방식은 테이블을 멈춘다.
 * 브로드캐스트 하나를 소켓 열 개가 각자 처리하는데, 셋째 소켓이 "내
 * 차례다"를 보고 액션을 보내려는 시점에는 아직 일곱이 안 받아 창이 열려
 * 있기 때문이다.
 *
 * ## 짝짓기의 전제와, 그것이 깨지는 자리
 *
 * 큐는 **"액션 하나당 브로드캐스트 하나"**를 전제하고 자리로 짝을 짓는다 —
 * 소켓마다 자기가 아직 못 본 가장 오래된 창에 기록한다. 그 전제가 깨지면
 * 짝이 한 칸씩 밀리고, 그러면 기록되는 값은 왕복이 아니라 **다음 사람의
 * 생각 시간**이 된다(수 초).
 *
 * 깨는 자리가 둘이고, 둘 다 여기서 막는다.
 *
 * 1. **응답이 없는 액션** — 서버가 no-op으로 흘린 액션은 브로드캐스트를
 *    안 만든다(`PlaysyncService.applyAction`의 `if (!applied) return null`).
 *    그 창은 고아가 되어 큐 앞에 눌러앉고, 다음 액션의 브로드캐스트를
 *    삼킨다. **부르는 쪽이 창을 안 열어야 한다** — `table.js`의 지각 액션이
 *    그렇다. 그래도 새는 것은 나이 상한이 걷어낸다(`expire`).
 * 2. **창이 없는 브로드캐스트** — 타임아웃 잡이 대신 폴드시키면 아무도 창을
 *    열지 않은 채 renderGame이 나간다. 그것이 열려 있는 창에 붙으면 그 창의
 *    진짜 응답은 갈 곳을 잃는다. **`serverTime` 도장으로 막는다** — 창이
 *    열리기 전에 서버를 떠난 봉투는 그 창의 응답일 수 없다.
 *
 * ## T76 — 왕복을 둘로 쪼갠다
 *
 * `serverTime`은 스냅샷이 **서버를 떠난 시각**이다(`WsGateway.toWireState`).
 * 그래서 왕복이 두 토막으로 갈린다.
 *
 *     serverMs = serverTime - 창을 연 시각     서버가 답을 만들기까지
 *     clientMs = 받은 시각   - serverTime      선과 측정기가 그것을 나르기까지
 *
 * 12,000명 실측에서 서버 lag은 중앙 2.34ms인데 왕복이 1초였다. 합계 하나로는
 * 그 1초가 서버 안인지 측정 경로인지 가릴 수 없다. 이 둘이 그것을 가른다.
 *
 * 두 컨테이너가 같은 커널 시계를 보므로 뺄셈이 성립한다. 그래도 음수가
 * 나올 수 있어(도장과 전송 사이에 이벤트 루프가 끼면 순서가 뒤집혀 보인다)
 * 0으로 자른다 — 음수 표본은 지표를 조용히 낮춘다.
 */

/**
 * @param {object} opts
 * @param {number} opts.maxAgeMs 응답이 이만큼 안 오면 그 창은 표본이 아니다.
 *   **왕복 규모로 줄이면 안 된다** — 진짜로 느린 왕복까지 버리게 되고, 그러면
 *   재려던 것(1초가 진짜인가)을 못 본다. 이 값은 "아예 안 왔다"만 걸러낸다.
 */
export function createWindowQueue({ maxAgeMs }) {
  /** @type {{ at: number, actorSocketIdx: number, seen: Set<number> }[]} */
  const windows = [];

  return {
    /** 액션을 보낸 순간. `at`은 보낸 쪽의 시계다. */
    open(at, actorSocketIdx) {
      windows.push({ at, actorSocketIdx, seen: new Set() });
    },

    /**
     * 응답이 끝내 안 온 창을 걷어낸다.
     *
     * **짝짓기보다 먼저 불러야 한다.** 남겨 두면 뒤에 오는 브로드캐스트가
     * 그 창에 붙어 지연이 실제와 무관하게 부푼다.
     *
     * @returns 버린 창의 수
     */
    expire(now) {
      let dropped = 0;
      while (windows.length > 0 && now - windows[0].at > maxAgeMs) {
        windows.shift();
        dropped += 1;
      }
      return dropped;
    },

    /**
     * 브로드캐스트 하나를 창에 짝짓는다.
     *
     * @param {number} socketIdx 받은 소켓
     * @param {number} receivedAt 받은 시각
     * @param {number|undefined} serverTime 봉투에 찍힌 서버 시각. 없으면 분해 없이 왕복만 낸다
     * @param {number} liveCount 살아 있는 소켓 수. **죽은 소켓을 기다리면 큐가
     *   영영 안 비고 지연이 계속 부푼다.** 소켓 하나가 죽으면(티켓 만료의
     *   1008, 서버 재시작) 그 창은 영영 안 채워져 큐 앞에 눌러앉는다. 실제로
     *   램프 B 첫 실행이 그렇게 죽었다 — 서버 lag 0.4ms · CPU 1.8%인데 한
     *   VU의 롤링 창이 p95 1,989ms를 보고 실행을 중단시켰다. **T76이 같은
     *   서명을 다시 냈다**(왕복 1,061ms · lag 2.34ms). 부푸는 길이 하나가
     *   아니었던 것이고, 그래서 나머지 둘을 위에 적었다.
     * @returns 짝지을 창이 없으면 `null`. 이 봉투가 창보다 먼저 떠났으면
     *   `{ stale: true }` — 짝짓지 않고 창도 건드리지 않는다.
     */
    match(socketIdx, receivedAt, serverTime, liveCount) {
      const win = windows.find((w) => !w.seen.has(socketIdx));
      if (!win) return null;

      // 창이 열리기 **전에** 서버를 떠난 봉투다. 그 창의 응답일 수 없다.
      // 창을 봤다고 표시하지도 않는다 — 진짜 응답이 아직 올 것이기 때문이다.
      //
      // 큐는 `at` 오름차순이라 가장 오래된 것이 걸리면 뒤도 전부 걸린다.
      // 그래서 다음 창을 찾아 내려가지 않는다.
      if (serverTime !== undefined && serverTime < win.at) return { stale: true };

      win.seen.add(socketIdx);
      const elapsedMs = receivedAt - win.at;
      const split =
        serverTime === undefined
          ? {}
          : {
              serverMs: Math.max(0, serverTime - win.at),
              clientMs: Math.max(0, receivedAt - serverTime),
            };

      // 살아 있는 소켓이 다 본 창은 앞에서 걷어낸다.
      while (windows.length > 0 && windows[0].seen.size >= liveCount) windows.shift();

      return { actorSocketIdx: win.actorSocketIdx, elapsedMs, ...split };
    },

    /** 재접속 폭발. 끊긴 소켓이 못 받은 창은 영영 안 채워진다. */
    clear() {
      windows.length = 0;
    },

    get size() {
      return windows.length;
    },
  };
}
