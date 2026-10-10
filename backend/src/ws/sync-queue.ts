const DEFAULT_HOLD_MS = 1000;

/** `SYNC_RECOUNT_HOLD_MS` — 0 이상의 정수. 미설정 · 빈 문자열 · 그 밖은 기본값. */
export function syncRecountHoldMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SYNC_RECOUNT_HOLD_MS;
  if (raw === undefined || raw === '') return DEFAULT_HOLD_MS;
  return /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_HOLD_MS;
}

const DEFAULT_DEALER_GONE_GRACE_MS = 10_000;

/**
 * `DEALER_GONE_GRACE_MS` — 마지막 딜러가 **스스로 닫았을 때** 대회를 멈추기까지 기다리는
 * 시간(T121). 새로고침과 화면 이동은 몇 초 안에 다시 붙는다 — 그것으로 대회가 멈추면
 * 안 된다. 응답이 없어 끊은 소켓과 서버가 내보낸 소켓에는 쓰지 않는다. 0 이상의 정수.
 */
export function dealerGoneGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DEALER_GONE_GRACE_MS;
  if (raw === undefined || raw === '') return DEFAULT_DEALER_GONE_GRACE_MS;
  return /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_DEALER_GONE_GRACE_MS;
}

/**
 * 대회별 재집계 줄(T96 리뷰 I1 · T117). 순수하다 — 소켓도 Redis도 모른다.
 *
 * **줄을 세우는 이유**(T96 리뷰 I1): 끝난 판정의 `await completeSync` 창에서 새
 * 재집계가 아직 커밋 전인 `SYNCING`을 읽으면 `{syncing:false}` 뒤에 낡은
 * `{syncing:true}`를 보낸다. 줄을 세우면 뒤의 것은 앞의 것이 커밋한 뒤에 다시 읽는다.
 *
 * **합치는 이유**(T117): 좌석 소켓까지 재집계를 부르면 대회 하나(1,400테이블)에서
 * 재접속 1만여 번이 줄 1만여 개가 된다. 아직 시작 안 한 재집계는 어차피 그 차례의
 * 최신 상태를 읽으므로 하나로 충분하다. 「달리는 것 하나 + 기다리는 것 하나」라
 * 위 성질은 그대로다.
 *
 * **보류 창(T117 실측)**: 합치기는 재집계가 다음 마이크로태스크에 시작하면 거의 일어나지
 * 않는다. 한 대회 1,000테이블·9,000명이 재시작 뒤 재접속하자 1만여 번이 각자 1,000테이블
 * 재집계와 1,000번 전송을 만들어 이벤트 루프가 포화됐고, 티켓 459개가 핸드셰이크 전에
 * 만료됐다. 새 재집계는 `holdMs` 동안 `waiting`에 머문 채 요청을 모은 뒤 시작한다 —
 * 풀림이 최대 `holdMs` 늦는 대신 대회당 재집계는 `holdMs`마다 많아야 한 번이다.
 *
 * 프로세스가 하나라(`backlog.md` B9) 메모리 줄로 충분하다.
 */
export class SyncQueue<W> {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, { joiners: W[]; done: Promise<void>; skipHold?: () => void }>();

  constructor(
    private readonly recount: (key: string, joiners: W[]) => Promise<void>,
    private readonly onError: (e: unknown) => void,
    private readonly holdMs = 0,
  ) {}

  recountLater(key: string, joiner?: W): Promise<void> {
    const pending = this.waiting.get(key);
    if (pending) {
      if (joiner !== undefined) pending.joiners.push(joiner);
      return pending.done;
    }
    const joiners: W[] = joiner === undefined ? [] : [joiner];
    const start = () => {
      // 시작하는 순간 합치기를 닫는다 — 이 뒤에 온 요청은 이 재집계가 못 본
      // 변화를 들고 있을 수 있어 새로 줄을 선다.
      this.waiting.delete(key);
      return this.recount(key, joiners);
    };
    // 보류는 끊을 수 있다(`enqueue`). 아직 보류에 들어가기 전에 끊겼으면 들어가지 않는다.
    let skipped = false;
    let wake: (() => void) | undefined;
    const hold = () => new Promise<void>((resolve) => {
      if (skipped) return resolve();
      const timer = setTimeout(resolve, this.holdMs);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    // 0이면 기다리지 않는다 — 타이머 틱 하나가 순서를 바꾸지 않게.
    const done = this.chain(key, this.holdMs > 0 ? () => hold().then(start) : start)
      .catch((e) => this.onError(e));
    this.waiting.set(key, { joiners, done, skipHold: () => { skipped = true; wake?.(); } });
    return done;
  }

  /**
   * 그 대회 줄에 일 하나를 세운다. **보류 중인 재집계가 있으면 보류를 끝낸다**(T121) —
   * 보류는 재접속 몰림을 합치려는 것이지 급한 일(상점의 강제 해제, 회선 끊김으로 대회
   * 멈추기)을 세워 두려는 것이 아니다. 순서는 그대로다: 그 재집계가 먼저 돌고 이 일이 돈다.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.waiting.get(key)?.skipHold?.();
    return this.chain(key, task);
  }

  private chain<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(task);
    const settled = next.then(() => undefined, () => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}
