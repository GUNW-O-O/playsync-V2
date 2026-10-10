/**
 * 대회장의 회선이 끊겨 멈춘 대회(T121). **프로세스 메모리에 산다.**
 *
 * 그 대회의 딜러 소켓이 전부 끊기면 서버가 대회를 `SYNCING`으로 멈춘다
 * (`RecoveryService.pauseForLineOutage`). 여기가 드는 것은 둘이다.
 *
 * - **원인** — 화면이 「서버가 멈췄다」가 아니라 「인터넷 연결」로 적게 한다. DB에 두지
 *   않는다. 재기동하면 실제로 서버 장애다.
 * - **리바인 대기를 끊는 신호** — Redis 장애는 `RedisOutage`의 세대가 오르며 대기 중인
 *   리바인을 접는데, 회선 끊김은 Redis가 살아 있어 그 세대가 안 오른다. 같은 모양을
 *   대회 키로 둔다(`PlaysyncService.waitForRebuyResponse`).
 *
 * `RedisOutage`와 같이 **인스턴스가 여럿이 되면 틀린다**(`backlog.md` B9).
 */
export class LinePause {
  private readonly generations = new Map<string, number>();
  private readonly down = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /** 멈출 때마다 오른다. 판을 시작할 때의 값과 다르면 그 사이에 멈췄다는 뜻이다. */
  generationOf(tournamentId: string): number {
    return this.generations.get(tournamentId) ?? 0;
  }

  /** 지금 회선 때문에 멈춰 있나. */
  isDown(tournamentId: string): boolean {
    return this.down.has(tournamentId);
  }

  /** 그 대회가 다음에 멈출 때 한 번 부른다. 반환값을 부르면 구독을 푼다. */
  onceDown(tournamentId: string, fn: () => void): () => void {
    let set = this.waiters.get(tournamentId);
    if (!set) {
      set = new Set();
      this.waiters.set(tournamentId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.waiters.get(tournamentId) === set) this.waiters.delete(tournamentId);
    };
  }

  markDown(tournamentId: string): void {
    this.generations.set(tournamentId, this.generationOf(tournamentId) + 1);
    this.down.add(tournamentId);
    const waiting = [...(this.waiters.get(tournamentId) ?? [])];
    this.waiters.delete(tournamentId);
    // 대기자 하나가 던져도 나머지는 마저 돈다(`RedisOutage.onLost`와 같다).
    for (const fn of waiting) { try { fn(); } catch { /* 무시 */ } }
  }

  /** 대회가 풀렸거나 닫혔다. 세대는 그대로 둔다 — 낡은 판이 여전히 낡았다. */
  clear(tournamentId: string): void {
    this.down.delete(tournamentId);
  }

  /** 서버 장애가 겹쳤다 — 그때부터는 서버 장애다. */
  clearAll(): void {
    this.down.clear();
  }
}

const pauses = new WeakMap<object, LinePause>();

/** 클라이언트 하나에 하나. `outageOf`와 같은 이유다 — `RedisService`가 둘이어도 한 상태를 본다. */
export function linePauseOf(client: object): LinePause {
  let pause = pauses.get(client);
  if (!pause) {
    pause = new LinePause();
    pauses.set(client, pause);
  }
  return pause;
}
