import Link from 'next/link';

export default function HomePage() {
  const navItems = [
    { name: '👤 유저 (마이페이지/포인트)', href: '/user', color: 'bg-blue-500' },
    { name: '🔑 로그인/회원가입', href: '/login', color: 'bg-gray-700' },
    { name: '🃏 딜러 (테이블/OTP 인증)', href: '/dealer', color: 'bg-red-600' },
    { name: '🏆 토너먼트 (대회 생성/목록)', href: '/tournaments', color: 'bg-yellow-600' },
    { name: '🏪 상점 (매장 관리/설정)', href: '/store', color: 'bg-green-600' },
    { name: 'PLAYSYNC', href: '/playsync', color: 'bg-emerald-600' },
  ];

  return (
    <main className="min-h-screen bg-gray-400 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-white shadow-xl rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-center text-gray-800 mb-2">
          Holdem SaaS MVP
        </h1>
        <p className="text-center text-gray-500 mb-8 text-sm">
          빠른 기능 테스트를 위한 개발자 내비게이션
        </p>

        <nav className="space-y-4">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block w-full text-center text-white font-semibold py-4 rounded-xl transition-transform active:scale-95 hover:opacity-90 ${item.color}`}
            >
              {item.name}
            </Link>
          ))}
        </nav>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <p className="text-xs text-center text-gray-400">
            Backend Status: <span className="text-green-500 font-bold">Connected</span> (Render)
          </p>
        </div>
      </div>
    </main>
  );
}