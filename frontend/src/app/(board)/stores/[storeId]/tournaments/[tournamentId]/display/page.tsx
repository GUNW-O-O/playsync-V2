'use client';

import { use } from 'react';
import DisplayClient from './DisplayClient';

// 이 라우트의 세그먼트는 [storeId]/[tournamentId]다. `id`를 읽으면
// undefined가 URL에 박혀 전광판이 죽는데, Next 16의 페이지 검증 타입이
// `& any`라 타입 체크로는 잡히지 않는다. `page.test.tsx`가 실제로 나가는
// URL을 보고 이 회귀를 지킨다.
export default function TournamentDashboard({
  params,
}: {
  params: Promise<{ storeId: string; tournamentId: string }>;
}) {
  const { tournamentId } = use(params);
  return <DisplayClient tournamentId={tournamentId} />;
}
