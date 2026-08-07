import DealerWaitingClient from './DealerWaitingClient';
import { authenticateDealer } from './action';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function json(path: string) {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

/**
 * 딜러 태블릿의 기본 상태. 좌석 대기 화면(`table/page.tsx`)과 같은 문법이다 —
 * 아는 것은 URL의 `?store=`뿐이다(대회가 바뀌어도 기기를 손댈 것이 없다).
 * `(terminal)/dealer/[id]/`가 대회 id를 URL에 박던 것을 없앤 이유이기도
 * 하다 — URL에 대회가 박히면 그게 곧 기기별 설정이라 대회마다 딜러 태블릿을
 * 손으로 고쳐야 한다.
 *
 * 좌석 점유 현황(`/tournaments/:id/seats`)은 읽지 않는다 — 딜러가 고르는
 * 것은 좌석이 아니라 테이블이다.
 */
export default async function DealerWaitingPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const { store } = await searchParams;
  // 이 화면을 보는 사람은 태블릿을 설치하는 직원이다. 무엇이 빠졌는지가
  // 아니라 **무엇을 고쳐야 하는지**를 적는다.
  if (!store)
    return (
      <main className="p-8 text-tb-ink">
        주소에 상점이 없습니다. {'?store=<상점 id>'}를 붙여 주세요.
      </main>
    );

  const tournaments = (await json(`/tournaments/stores/${store}`)) ?? [];
  const current = tournaments[0] ?? null;
  const session = current ? await json(`/dealer/${current.id}`) : null;

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      <DealerWaitingClient
        storeId={store}
        tournaments={tournaments}
        tables={session?.tables ?? []}
        authenticateDealer={authenticateDealer}
      />
    </main>
  );
}
