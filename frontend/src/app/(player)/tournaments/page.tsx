import Link from 'next/link';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/** `GET /tournaments/stores`의 행. `store.findMany`가 그대로 나온다. */
type Store = { id: string; name: string };

/**
 * `GET /tournaments/stores/:storeId`의 행.
 *
 * 출처는 `backend/src/payment/payment.service.ts`의
 * `getStoreAvailableSessions` — `PENDING`과 `ONGOING`만, `dealerOtpHash`를
 * `omit`한 `Tournament` 행이다. 화면이 쓰는 것만 추린다.
 */
type StoreTournament = {
  id: string;
  name: string;
  status: string;
  isRegistrationOpen: boolean;
  entryFee: number;
  startStack: number;
  totalPlayers: number;
};

/**
 * 상점 검색. 백엔드의 쿼리 키가 `id`인데 실제로 하는 일은 **이름
 * contains**다(`searchStore`). 키 이름을 여기서 고쳐 부르지 않는다 —
 * 화면이 부르는 이름과 서버가 받는 이름이 갈라지면 둘 중 어느 쪽이
 * 사실인지 화면만 봐서는 알 수 없게 된다.
 *
 * 검색어가 없으면 서버의 `contains`가 통째로 빠져 상점 전체가 온다.
 * 그것을 기본 목록으로 쓴다 — "전체 상점" 엔드포인트를 따로 지어내지
 * 않기 위해서다.
 */
async function fetchStores(query: string): Promise<Store[]> {
  const url = new URL(`${BACKEND_URL}/tournaments/stores`);
  if (query) url.searchParams.set('id', query);

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return [];
  return (await res.json()) as Store[];
}

async function fetchStoreTournaments(storeId: string): Promise<StoreTournament[] | null> {
  const res = await fetch(`${BACKEND_URL}/tournaments/stores/${storeId}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as StoreTournament[];
}

/**
 * 대회 찾기. **두 걸음이다** — 상점을 고르고, 그 상점의 대회를 고른다.
 *
 * 한 화면에 대회를 전부 늘어놓지 않는 이유는 백엔드에 그런 조회가 없기
 * 때문이 아니라, 도메인이 그렇기 때문이다. 대회는 상점이 연다
 * (`Tournament.storeId`). 사람은 이미 어느 홀에 갈지 정하고 움직인다.
 *
 * 걸음을 URL에 담는다(`?q=` · `?store=`). 그래야 뒤로 가기가 검색 결과로
 * 돌아오고, 클라이언트 상태가 하나도 필요 없다.
 */
export default async function TournamentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; store?: string }>;
}) {
  const { q = '', store: storeId } = await searchParams;

  if (storeId) {
    return <StoreTournaments storeId={storeId} query={q} />;
  }

  const stores = await fetchStores(q);

  return (
    <div className="flex flex-col gap-6 p-6 pb-10">
      {/* 도메인 설명("대회는 상점이 연다")을 문단으로 적지 않는다. 제목과
          입력 label과 목록이 그 순서를 이미 보여준다. */}
      <h1 className="text-[28px] font-light leading-[1.2]">대회 찾기</h1>

      {/* 평범한 GET 폼이다. 검색어가 주소에 남아야 뒤로 가기가 결과로 돌아온다. */}
      <form action="/tournaments" method="get" className="flex">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="상점 이름"
          aria-label="상점 이름"
          /* Carbon text-input — 회색 바탕, 사각, 아래 1px 실선.
             포커스는 파랑 2px 밑줄(inset shadow라 자리가 밀리지 않는다). */
          className="h-12 min-w-0 flex-1 border-b border-[var(--ink)] bg-[var(--surface)] px-4 text-[16px] tracking-[0.16px] outline-none placeholder:text-[var(--ink-subtle)] focus:shadow-[inset_0_-2px_0_var(--blue)]"
        />
        <button
          type="submit"
          className="h-12 shrink-0 bg-[var(--blue)] px-5 text-[14px] tracking-[0.16px] text-white transition-colors hover:bg-[#0050e6] active:bg-[var(--blue-80)]"
        >
          검색
        </button>
      </form>

      {stores.length === 0 ? (
        <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
          {q ? '검색 결과가 없습니다.' : '등록된 상점이 없습니다.'}
        </p>
      ) : (
        <ul className="border-t border-[var(--hairline)]">
          {stores.map((s) => (
            <li key={s.id}>
              <Link
                href={`/tournaments?store=${s.id}`}
                data-testid={`pick-store-${s.id}`}
                className="flex h-12 items-center justify-between gap-4 border-b border-[var(--hairline)] text-[16px] tracking-[0.16px] hover:bg-[var(--surface)]"
              >
                <span className="truncate">{s.name}</span>
                <span aria-hidden className="shrink-0 text-[var(--blue)]">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function StoreTournaments({ storeId, query }: { storeId: string; query: string }) {
  // 이름을 얻으려고 상점을 한 번 더 읽는다. id 하나로 상점을 읽는 라우트가
  // 없고, 이름을 URL에 실어 나르면 주소를 고친 값이 그대로 제목이 된다.
  const [stores, tournaments] = await Promise.all([
    fetchStores(''),
    fetchStoreTournaments(storeId),
  ]);
  const store = stores.find((s) => s.id === storeId);

  const backHref = query ? `/tournaments?q=${encodeURIComponent(query)}` : '/tournaments';

  return (
    <div className="flex flex-col gap-6 p-6 pb-10">
      <div className="flex flex-col gap-3">
        <Link
          href={backHref}
          className="text-[14px] tracking-[0.16px] text-[var(--blue)] hover:underline"
        >
          ← 상점 다시 고르기
        </Link>
        <h1 className="text-[28px] font-light leading-[1.2]">{store?.name ?? '상점'}</h1>
      </div>

      {tournaments === null ? (
        <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
          대회를 불러오지 못했습니다.
        </p>
      ) : tournaments.length === 0 ? (
        // `getStoreAvailableSessions`는 PENDING·ONGOING만 준다. 끝난 대회는
        // 애초에 오지 않으므로 "없다"가 곧 "지금 열린 것이 없다"다.
        <p className="text-[14px] leading-[1.29] tracking-[0.16px] text-[var(--ink-muted)]">
          열린 대회가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {tournaments.map((t) => {
            const open = t.isRegistrationOpen && t.status !== 'FINISHED';
            return (
              <li key={t.id}>
                <Link
                  href={`/tournaments/${t.id}`}
                  data-testid={`pick-tournament-${t.id}`}
                  /* Carbon feature-card. 링크 전체가 타깃이라 손가락이 어디를
                     눌러도 열린다. */
                  className="flex flex-col gap-3 border border-[var(--hairline)] p-6 hover:bg-[var(--surface)]"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-[20px] leading-[1.4]">{t.name}</span>
                    <span
                      className={`text-[12px] leading-[1.33] tracking-[0.32px] ${
                        open ? 'text-[var(--ok)]' : 'text-[var(--ink-subtle)]'
                      }`}
                    >
                      {open ? '등록 열림' : '등록 마감'}
                    </span>
                  </div>

                  <dl className="flex flex-col gap-1.5 text-[14px] tracking-[0.16px]">
                    <Row label="참가비" value={t.entryFee.toLocaleString()} />
                    <Row label="시작 스택" value={t.startStack.toLocaleString()} />
                    <Row label="현재 참가" value={`${t.totalPlayers}명`} />
                  </dl>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--ink-subtle)]">{label}</dt>
      <dd className="font-mono text-[var(--ink)]">{value}</dd>
    </div>
  );
}
