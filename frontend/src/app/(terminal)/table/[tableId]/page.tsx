import { cookies } from 'next/headers';
import SeatGameClient from './SeatGameClient';
import { TableState } from '@/app/types/game';

type InitialGameData = { tableState: TableState; seatIndex: number };

/**
 * 첫 화면에 그릴 스냅샷. **실패는 `null`이다.**
 *
 * 예전에는 `res.ok`를 안 보고 `res.json()`을 그대로 돌려줬다. NestJS 예외
 * 본문(`{ statusCode, message }`)은 truthy라 아래 `initialData ? … : …`가
 * 401(좌석 토큰 만료)·500(스냅샷 유실)에도 성공 분기를 탔고,
 * `initialData.tableState`가 `undefined`인 채 빈 펠트가 그려져 **영원히 안
 * 움직였다.** 폴백 문구는 본문이 리터럴 `null`이어야만 나오는 죽은 코드였다.
 *
 * `tableState`까지 보는 것은 프록시가 만들어 내는 빈 200을 위한 그물이다 —
 * `PlaysyncService.joinTable`은 스냅샷이 없으면 던지므로 정상 경로에 그런
 * 본문이 없지만, 없으면 그 결과가 401·500과 똑같이 빈 펠트다.
 */
async function getInitialGameData(tableId: string): Promise<InitialGameData | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value || cookieStore.get('accessToken')?.value;

  if (!token) {
    console.error("인증 토큰이 없습니다.");
  }
  const res = await fetch(`${process.env.BACKEND_URL}/playsync/${tableId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    cache: 'no-store'
  });

  if (!res.ok) {
    console.error(`테이블 상태를 불러오지 못했습니다. (${res.status})`);
    return null;
  }

  const body = (await res.json().catch(() => null)) as InitialGameData | null;
  if (!body?.tableState) {
    console.error('테이블 상태 응답에 tableState가 없습니다.');
    return null;
  }
  return body;
}

/**
 * 대기 화면(`/table?store=`)으로 돌아갈 때 쓸 매장 id를 구한다.
 *
 * `GET /playsync/:tableId`(위 `getInitialGameData`) 응답에는 storeId가
 * 없다 — 테이블 상태는 매장을 모른다. `TableState.tournamentId`(Redis
 * 스냅샷에 실제로 실려 온다 — `entry.service.ts`의 `emptyTableState`,
 * `recovery.service.ts`가 세울 때부터 채운다)로 대회 정보를 한 번 더
 * 불러 얻는다.
 *
 * `GET /tournaments/:id`(`payment.service.ts`의 `getTournamentInfo`)는
 * `{ tournament, seatStatus }` 봉투로 온다. `storeId`는 `tournament.storeId`에
 * 있다 — 봉투째로 캐스팅해 최상위에서 읽으면 항상 undefined가 된다(리뷰 지적).
 *
 * 이 조회가 실패해도 게임 화면 자체를 죽이지 않는다 — 탈락 복귀 주소를
 * 못 구할 뿐이고, 그 정도로 화면 전체가 500이 되는 건 균형이 안 맞는다.
 */
async function getTableContext(
  tournamentId: string | undefined,
  tableId: string,
): Promise<{ storeId?: string; tableOrder?: number }> {
  if (!tournamentId) return {};
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/tournaments/${tournamentId}`, { cache: 'no-store' });
    if (!res.ok) return {};
    const body = (await res.json().catch(() => null)) as {
      tournament?: { storeId?: string; tables?: { id: string; tableOrder: number }[] };
    } | null;
    return {
      storeId: body?.tournament?.storeId,
      // 같은 조회가 `tables`까지 select한다(`getTournamentInfo`). 번호를
      // 얻자고 요청을 하나 더 보내지 않는다.
      tableOrder: body?.tournament?.tables?.find((t) => t.id === tableId)?.tableOrder,
    };
  } catch (err) {
    console.error('대회 정보를 불러오지 못해 테이블 정보를 구하지 못했습니다.', err);
    return {};
  }
}

export default async function GamePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  const initialData = await getInitialGameData(tableId);
  const { storeId, tableOrder } = await getTableContext(
    initialData?.tableState?.tournamentId,
    tableId,
  );

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      {initialData ? (
        <SeatGameClient
          tableId={tableId}
          initialData={initialData.tableState}
          seatIndex={initialData.seatIndex}
          storeId={storeId}
          tableOrder={tableOrder}
        />
      ) : (
        // 이 자리에 오는 것은 이제 실패뿐이다(위 `getInitialGameData`).
        // "아직 게임이 시작되지 않았습니다"는 거짓이 된다 — 앉은 사람이
        // 기다리면 낫는 줄 알고 계속 앉아 있는다.
        <p className="p-8 text-tb-ink">
          테이블 정보를 불러오지 못했습니다. 화면을 새로고침하거나 운영자에게 알려주세요.
        </p>
      )}
    </main>
  );
}
