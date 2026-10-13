/**
 * 접기 직전에 딜러가 살아 있는지 묻는 자리(T130). **프로세스 메모리에 산다.**
 *
 * 묻는 쪽(타임아웃 워커 · 리바인 대기)은 `PlaysyncModule`에 있고 답하는 쪽(소켓)은
 * 게이트웨이에 있다. 게이트웨이가 `PlaysyncService`에 기대므로 반대로 주입하면 고리가
 * 된다 — `LinePause`처럼 Redis 클라이언트에 붙은 등록부를 둘이 같이 본다.
 *
 * **건 확인이 없으면 true다.** 시나리오 · 통합 테스트는 게이트웨이 없이 서비스를 세운다.
 * 운영에서는 늘 `WsModule`이 서서 건다.
 *
 * `LinePause`와 같이 **인스턴스가 여럿이 되면 틀린다**(`backlog.md` B9).
 */
export type DealerCheck = (tableId: string) => Promise<boolean>;

export class DealerLiveness {
  private check: DealerCheck | null = null;

  /** 게이트웨이가 건다. 반환값을 부르면 푼다 — 그새 다른 확인이 걸렸으면 그대로 둔다. */
  attach(check: DealerCheck): () => void {
    this.check = check;
    return () => { if (this.check === check) this.check = null; };
  }

  /** 그 테이블의 딜러가 지금 답하나. */
  confirm(tableId: string): Promise<boolean> {
    return this.check ? this.check(tableId) : Promise.resolve(true);
  }
}

const registries = new WeakMap<object, DealerLiveness>();

/** 클라이언트 하나에 하나. `linePauseOf`와 같은 이유다. */
export function dealerLivenessOf(client: object): DealerLiveness {
  let l = registries.get(client);
  if (!l) {
    l = new DealerLiveness();
    registries.set(client, l);
  }
  return l;
}
