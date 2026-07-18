import Link from 'next/link';
import { getMyStores } from './action';

export default async function StoreListPage() {
  const stores = await getMyStores();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">내 상점 관리</h1>

      {stores.length === 0 ? (
        <>
          <p>등록된 상점이 없습니다. 상점을 먼저 생성해주세요.</p>
          <Link
            href="/store/create"
            className="bg-blue-600 text-white px-4 py-2 rounded mt-4"
          >
            생성하기
          </Link>
        </>
      ) : (
        <div className="grid gap-4">
          {stores.map((store: any) => (
            <div key={store.id} className="border p-4 rounded shadow-sm flex justify-between">
              <div>
                <h2 className="text-xl font-semibold">{store.name}</h2>
                <p className="text-gray-600">{store.address}</p>
              </div>
              <Link
                href={`/store/${store.id}`}
                className="bg-green-500 text-white px-4 py-2 rounded self-center"
              >
                관리하기
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}