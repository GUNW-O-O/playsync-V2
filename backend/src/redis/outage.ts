import { EventEmitter } from 'events';
import type Redis from 'ioredis';

/**
 * Redis 장애 상태(T97). **프로세스 메모리에 산다.**
 *
 * 부팅 복구(`RecoveryService.recoverAll`)는 프로세스가 새로 뜰 때만 돈다.
 * 백엔드는 살아 있고 Redis만 죽었다 돌아오면 부팅이 없어서, 차례였던 사람이
 * 이미 지난 마감으로 폴드됐다. 이 클래스가 그 경로의 시작점이다.
 *
 * **`close`가 아니라 `reconnecting`으로 감지한다.** ioredis는 `quit()`·
 * `disconnect()`로 닫을 때도 `close`를 내지만, 그때는 다시 붙지 않으므로
 * `reconnecting`이 오지 않는다. `close`로 보면 앱을 끌 때마다 대회가
 * `SYNCING`이 된다.
 *
 * **인스턴스가 여럿이 되면 이 설계는 틀린다**(`backlog.md` B9). 판정에 쓰는
 * 사실을 Redis로 옮길 모양은 스펙의 「인스턴스가 여럿이 되면」에 있다.
 */
export type OutagePhase = 'booting' | 'up' | 'down' | 'recovering';

export class RedisOutage extends EventEmitter {
  phase: OutagePhase;
  /** 장애가 날 때마다 오른다. 락 안에서 이 값이 바뀌었으면 그 사이에 끊겼다는 뜻이다. */
  generation = 0;
  /** 이번 장애가 **처음** 감지된 시각. 복구 중 다시 끊겨도 덮지 않는다. */
  downSince: number | null = null;

  constructor(client: Pick<Redis, 'on' | 'status'>, private readonly now: () => number = Date.now) {
    super();
    this.phase = client.status === 'ready' ? 'up' : 'booting';
    client.on('reconnecting', () => this.onLost());
    client.on('ready', () => this.onReady());
  }

  isUp(): boolean {
    return this.phase === 'up';
  }

  /** 복구 스윕이 끝났다. `RecoveryService.recoverFromOutage`만 부른다. */
  markRecovered(): void {
    if (this.phase !== 'recovering') return;
    this.phase = 'up';
    this.downSince = null;
    this.emit('recovered');
  }

  private onLost() {
    if (this.phase === 'down') return;
    this.generation += 1;
    this.downSince ??= this.now();
    this.phase = 'down';
    this.emit('down', this.downSince);
  }

  private onReady() {
    if (this.phase === 'booting') {
      this.phase = 'up';
      return;
    }
    if (this.phase !== 'down') return;
    this.phase = 'recovering';
    this.emit('up');
  }
}

const outages = new WeakMap<object, RedisOutage>();

/**
 * 클라이언트 하나에 장애 상태 하나. 장애는 **연결**의 성질이라, 같은 클라이언트를
 * 쓰는 `RedisService`가 여럿이어도 같은 상태를 봐야 한다. 프로덕션은 클라이언트와
 * 서비스가 하나씩이지만, 통합 테스트는 한 클라이언트에 서비스를 테스트마다 새로
 * 세운다 — 매번 구독하면 클라이언트에 리스너가 쌓인다.
 */
export function outageOf(client: Pick<Redis, 'on' | 'status'>): RedisOutage {
  let outage = outages.get(client);
  if (!outage) {
    outage = new RedisOutage(client);
    outages.set(client, outage);
  }
  return outage;
}
