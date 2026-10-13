import { DealerLiveness, dealerLivenessOf } from './dealer-liveness';

describe('DealerLiveness (T130)', () => {
  /** 시나리오 · 통합 테스트는 게이트웨이 없이 서비스를 세운다. 물을 소켓 계층이 없다. */
  it('건 확인이 없으면 true다', async () => {
    expect(`답 ${await new DealerLiveness().confirm('t')}`).toBe('답 true');
  });

  it('건 확인에 묻는다 — 테이블 id를 그대로 넘긴다', async () => {
    const l = new DealerLiveness();
    const asked: string[] = [];
    l.attach(async (tableId) => { asked.push(tableId); return false; });
    expect(`답 ${await l.confirm('t1')} 물음 ${asked.join(',')}`).toBe('답 false 물음 t1');
  });

  /** 게이트웨이가 내려가면 그 확인은 죽은 소켓 방을 본다. */
  it('해제하면 다시 true다', async () => {
    const l = new DealerLiveness();
    const off = l.attach(async () => false);
    off();
    expect(`답 ${await l.confirm('t')}`).toBe('답 true');
  });

  /** 늦게 푼 낡은 해제가 새 등록을 지우면 안 된다(게이트웨이를 `new`로 여러 번 세우는 테스트). */
  it('낡은 해제는 새 등록을 건드리지 않는다', async () => {
    const l = new DealerLiveness();
    const offOld = l.attach(async () => true);
    l.attach(async () => false);
    offOld();
    expect(`답 ${await l.confirm('t')}`).toBe('답 false');
  });

  it('클라이언트 하나에 하나다', () => {
    const client = {};
    expect(`같다 ${dealerLivenessOf(client) === dealerLivenessOf(client)}`).toBe('같다 true');
  });
});
