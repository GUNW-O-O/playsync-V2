'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';

const DEFAULT_AUTH_ERROR = 'OTP를 확인하세요.';

/**
 * 실패 응답에서 안내 문구를 꺼낸다.
 *
 * NestJS 예외 필터의 본문은 `{ statusCode, message, error }`이고, `message`는
 * 예외에서 온 문자열이거나 ValidationPipe에서 온 문자열 배열이다. 본문이 비어
 * 있거나 JSON이 아닌 경우(프록시가 끊은 502 등)도 있으므로 기본 문구로 떨어진다.
 */
async function failureMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const message = (body as { message?: unknown } | null)?.message;

  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && message.length > 0) return message.join(' ');
  return DEFAULT_AUTH_ERROR;
}

export default function DealerAuthPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const tournamentId = resolvedParams.id;
  const [tournament, setTournament] = useState<any>(null);
  const [selectedTable, setSelectedTable] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/dealer/${tournamentId}`)
      .then(res => res.json())
      .then(data => {
        setTournament(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const handleAuth = async () => {
    if (!tournament) {
      alert('대회를 먼저 선택해주세요.');
      return;
    }
    const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/dealer/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: tournamentId,
        tableId: selectedTable,
        otp: otp
      })
    });

    if (res.ok) {
      const { accessToken } = await res.json();
      Cookies.set('dealerToken', accessToken, {
        expires: 1,
        path: '/',
        sameSite: 'lax',
        // secure: true
      });
      alert(`인증 성공 tableId: ${selectedTable}`);
      router.push(`/table/${selectedTable}`);
    } else {
      // 백엔드가 실패를 네 가지로 가른다 — 401 자격 오류, 403 시도 초과(5분
      // 잠금), 403 종료된 대회, 409 딜러 세션 미준비. 딜러가 해야 할 일이
      // 전부 다르다. 한 문구로 뭉개면 잠긴 딜러가 OTP를 다시 넣고, 그 시도가
      // 카운터를 늘려 잠금 창을 한 번 더 태운다.
      alert(`인증 실패: ${await failureMessage(res)}`);
    }
  };

  if (loading) return <div className="p-8 text-center">데이터 로딩 중...</div>;

  return (
    <div className="p-8 max-w-md mx-auto space-y-6">
      <h1 className="text-2xl font-bold">딜러 테이블 인증</h1>

      <h3 className="text-xl font-bold">{tournament.name}</h3>

        <select
          onChange={(e) => setSelectedTable(e.target.value)}
          className="w-full p-3 border rounded-xl"
        >
          <option value="">테이블 선택</option>
          {/* ?. 을 사용하여 tables가 없을 경우를 대비합니다 */}
          {tournament?.tables?.map((table: any) => (
            <option key={table.id} value={table.id}>
              {table.tableOrder}번 테이블
            </option>
          ))}
        </select>

      <input
        type="text"
        inputMode="numeric"
        maxLength={6}
        placeholder="6자리 OTP 입력"
        value={otp}
        onChange={(e) => setOtp(e.target.value)}
        className="w-full p-3 border rounded-xl text-center text-2xl tracking-widest"
      />

      <button
        onClick={handleAuth}
        disabled={!selectedTable || !otp} // 버튼 활성화 조건 추가
        className="w-full bg-blue-500 text-white py-4 rounded-xl font-bold disabled:bg-gray-400"
      >
        인증
      </button>
    </div>
  );
}