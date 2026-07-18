'use client'

import { useState } from 'react';
import Link from 'next/link';

export default function ShopSearchPage() {
  const [query, setQuery] = useState('');
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [tournament, setTournament] = useState<any[]>([]);

  const searchStores = async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tournaments/stores?id=${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res) {
      alert('검색 결과가 없습니다.');
      setQuery('');
      return data;
    }
    setStores(data);
    setSelectedStore(null); // 검색 시 이전 선택 초기화
  }

  const handleShopClick = async (shopId: string) => {
    setSelectedStore(shopId);
    const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tournaments/stores/${shopId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) {
      const data = await res.json();
      setTournament(data);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">상점 검색</h1>

      {/* 검색창 */}
      <div className="flex gap-2 mb-8">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="상점 이름을 입력하세요..."
          className="flex-1 border p-2 rounded text-white"
        />
        <button onClick={searchStores} className="bg-blue-500 text-white px-4 py-2 rounded">
          검색
        </button>
      </div>

      <div className="grid grid-cols-2 gap-8">
        {/* 상점 리스트 */}
        <div>
          <h2 className="text-lg font-semibold mb-4">검색 결과</h2>
          <ul className="space-y-2">
            {stores.map((store) => (
              <li
                key={store.id}
                onClick={() => handleShopClick(store.id)}
                className={`p-3 border rounded cursor-pointer hover:bg-blue-200 text-black ${selectedStore === store.id ? 'border-blue-500 bg-blue-300' : ''}`}
              >
                {store.name}
              </li>
            ))}
            {stores.length === 0 && <p className="text-gray-500">검색 결과가 없습니다.</p>}
          </ul>
        </div>

        {/* 대회 리스트 */}
        <div>
          <h2 className="text-lg font-semibold mb-4">참여 가능 대회</h2>

          {!selectedStore ? (
            <p className="text-gray-500">상점을 선택해주세요.</p>

          ) : tournament.length === 0 ? (
            <p className="text-red-500">
              {stores.find(s => s.id === selectedStore)?.name}의 진행 중인 대회가 없습니다.
            </p>

          ) : (
            <ul className="space-y-2">
              {tournament.map((t) => (
                <li key={t.id} className="p-3 bg-gray-50 border rounded">
                  <div className='flex flex-row gap-3 items-center justify-between'>
                    <p className="font-medium text-gray-800">{t.name}</p>
                    <p className="text-sm text-gray-600">참가비 : {t.entryFee}</p>
                  </div>
                  <div className='flex flex-row gap-3 items-center'>
                    <p className="text-sm text-gray-600">
                      인원 : {t.activePlayers} / {t.totalPlayers}
                    </p>
                    <p className="text-sm text-gray-600">시작스택 : {t.startStack}</p>
                  </div>
                  <div className='flex flex-row gap-3'>
                    <Link href={`/tournaments/${t.id}`} className='flex flex-1 bg-blue-500 border rounded justify-center'>플레이어참가</Link>
                    <Link href={`/dealer/${t.id}`} className='flex flex-1 bg-red-500 border rounded justify-center'>딜러참가</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}