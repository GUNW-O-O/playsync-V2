import { cookies } from 'next/headers';
import DealerGameClient from './DealerGameClient';
import { TableState } from '@/app/types/game';

type InitialGameData = { tableState: TableState; seatIndex: number };

/**
 * `GET /playsync/:tableId`(`playsync.controller.ts`의 `joinTable`)는
 * `req.user.userId`로 좌석 인덱스를 찾는다. 딜러 JWT는 `JwtStrategy`가
 * `id`로 내보내고 `userId`는 채우지 않으므로(`jwt.strategy.ts` DEALER 분기),
 * 서비스가 받는 `userId`는 `undefined`고 `joinTable`이 `seatIndex: -1`을
 * 돌려준다 — 딜러는 애초에 좌석이 없으므로 그 값을 화면에서 쓰지 않는다.
 *
 * **실패는 `null`이다.** 좌석 화면과 같은 판정이고 같은 이유다
 * (`(terminal)/table/[tableId]/page.tsx`의 `getInitialGameData`) — 예외
 * 본문이 truthy라 아래 삼항이 항상 성공 분기를 탔고, `tableState`가
 * `undefined`인 채 빈 펠트가 그려졌다. 딜러 화면에서는 그 상태로 "핸드
 * 시작"이 눌리지 않아 **테이블 하나가 통째로 멈춘다.**
 */
async function getInitialGameData(tableId: string): Promise<InitialGameData | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('dealerToken')?.value;

  if (!token) {
    console.error('인증 토큰이 없습니다.');
  }
  const res = await fetch(`${process.env.BACKEND_URL}/playsync/${tableId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
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
 * 눈앞의 테이블에 붙은 번호를 구한다. 좌석 화면과 같은 조회다
 * (`(terminal)/table/[tableId]/page.tsx`) — 테이블 상태는 자기 번호를 모르고,
 * `GET /tournaments/:id`가 `{ tournament, seatStatus }` 봉투 안에 `tables`를
 * 함께 내려준다.
 *
 * 실패해도 화면을 죽이지 않는다. 번호를 못 구할 뿐이고, 그때 머리글은
 * uuid로 되돌아가는 대신 테이블 쪽을 뺀다.
 */
async function getTableOrder(
  tournamentId: string | undefined,
  tableId: string,
): Promise<number | undefined> {
  if (!tournamentId) return undefined;
  try {
    const res = await fetch(`${process.env.BACKEND_URL}/tournaments/${tournamentId}`, {
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as {
      tournament?: { tables?: { id: string; tableOrder: number }[] };
    } | null;
    return body?.tournament?.tables?.find((t) => t.id === tableId)?.tableOrder;
  } catch (err) {
    console.error('대회 정보를 불러오지 못해 테이블 번호를 구하지 못했습니다.', err);
    return undefined;
  }
}

export default async function DealerGamePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  const initialData = await getInitialGameData(tableId);
  const tableOrder = await getTableOrder(initialData?.tableState?.tournamentId, tableId);

  return (
    <main className="h-screen overflow-hidden bg-tb-bg">
      {initialData ? (
        <DealerGameClient
          tableId={tableId}
          initialData={initialData.tableState}
          tableOrder={tableOrder}
        />
      ) : (
        // 이 자리에 오는 것은 이제 실패뿐이다(위 `getInitialGameData`).
        // 딜러 OTP를 다시 넣어야 하는 경우(토큰 만료)가 여기 섞이므로
        // "아직 시작되지 않았다"고 적으면 딜러가 기다린다.
        <p className="p-8 text-tb-ink">
          테이블 정보를 불러오지 못했습니다. 화면을 새로고침하거나 운영자에게 알려주세요.
        </p>
      )}
    </main>
  );
}
