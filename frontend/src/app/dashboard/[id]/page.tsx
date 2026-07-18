'use client';

import { useEffect, useState, useRef, use } from 'react';

export default function TournamentDashboard({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const tournamentId = resolvedParams.id;
  const [data, setData] = useState<any>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/playsync/dashboard/${tournamentId}`);
      console.log(res)
      if (!res.ok) {
        throw new Error('데이터 로드 실패');
      }
      const result = await res.json();
      setData(result);

      // 1. 남은 시간 계산 (초 단위)
      const now = result.blindField.serverTime;
      const next = result.blindField.nextLevelAt;
      const diffSeconds = Math.max(0, Math.floor((next - now) / 1000));
      setTimeLeft(diffSeconds);

      // 2. 다음 폴링 스케줄링
      const currentLv = result.blindField.currentBlindLv;

      if (currentLv === 99) {
        // 다음 레벨 시작 10초 전까지만 쉽니다. (최소 5초는 확보)
        const sleepTime = Math.max(5000, (diffSeconds - 10) * 1000);
        console.log(`휴식 중... ${sleepTime / 1000}초 후에 폴링을 재개합니다.`);

        timerRef.current = setTimeout(fetchData, sleepTime);
      } else {
        // 일반 상황: 5초마다 폴링
        timerRef.current = setTimeout(fetchData, 5000);
      }
    } catch (err) {
      console.error(err);
      // 에러 시 10초 후 재시도
      timerRef.current = setTimeout(fetchData, 10000);
    }
  };

  useEffect(() => {
    fetchData(); // 첫 실행
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [tournamentId]);

  // 화면 타이머 1초마다 깎는 로직은 별도 유지
  useEffect(() => {
    const clock = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(clock);
  }, []);

  if (!data) return <div className="bg-black h-screen text-white p-10 font-bold">DASHBOARD LOADING...</div>;
  const { dashboard, blindField } = data;
  const currentBlind = blindField.blindStructure[blindField.currentBlindLv];
  const nextBlind = blindField.blindStructure[blindField.currentBlindLv + 1];

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full h-screen bg-black text-white p-6 font-sans overflow-hidden flex flex-col gap-6">

      {/* 상단 메인 섹션: 남은 시간 & 현재 블라인드 */}
      <div className="flex-1 grid grid-cols-12 gap-6">

        {/* 현재 블라인드 정보 (좌측 4) */}
        <div className="col-span-4 bg-slate-900 rounded-3xl p-8 border border-slate-800 flex flex-col justify-between shadow-2xl">
          <div>
            <h2 className="text-indigo-400 text-2xl font-black uppercase tracking-tighter">Current Level</h2>
            <div className="text-[120px] font-black leading-none mt-4 italic text-white">
              LV.{currentBlind?.lv || blindField.currentBlindLv + 1}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-slate-400 text-xl font-bold uppercase">Blinds</p>
            <p className="text-6xl font-black text-yellow-400">
              {currentBlind?.sb.toLocaleString()} / {(currentBlind?.sb * 2).toLocaleString()}
            </p>
            {currentBlind?.ante && (
              <p className="text-3xl text-slate-300 font-bold">Ante: {currentBlind.sb.toLocaleString()}</p>
            )}
          </div>
        </div>

        {/* 남은 시간 타이머 (중앙 8) */}
        <div className={`col-span-8 rounded-3xl flex flex-col items-center justify-center border-4 shadow-[0_0_50px_rgba(0,0,0,0.5)] transition-colors
          ${blindField.isBreak ? 'bg-blue-900 border-blue-500' : 'bg-slate-900 border-slate-800'}`}>
          <h1 className="text-4xl font-black uppercase tracking-[0.5em] mb-4 text-slate-400">
            {blindField.isBreak ? '☕ Break Time' : 'Next Level In'}
          </h1>
          <div className="text-[220px] font-black font-mono leading-none tracking-tighter tabular-nums">
            {formatTime(timeLeft)}
          </div>
        </div>
      </div>

      {/* 하단 통계 섹션 */}
      <div className="h-1/3 grid grid-cols-4 gap-6">
        {/* 통계 카드 1: 엔트리 현황 */}
        <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 flex flex-col justify-center">
          <span className="text-slate-500 font-bold uppercase text-lg">Entries / Active</span>
          <div className="text-5xl font-black mt-2">
            <span className="text-indigo-500">{dashboard.activePlayer}</span>
            <span className="text-slate-600 mx-2">/</span>
            <span className="text-white">{dashboard.totalPlayer}</span>
          </div>
        </div>

        {/* 통계 카드 2: 평균 스택 */}
        <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 flex flex-col justify-center">
          <span className="text-slate-500 font-bold uppercase text-lg">Avg Stack</span>
          <div className="text-5xl font-black mt-2 text-green-400">
            {dashboard.avgStack.toLocaleString()}
          </div>
        </div>

        {/* 통계 카드 3: 총 상금 (Buy-in 합계) */}
        <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 flex flex-col justify-center">
          <span className="text-slate-500 font-bold uppercase text-lg">Total Prize Pool</span>
          <div className="text-5xl font-black mt-2 text-yellow-500">
            ₩{dashboard.totalBuyinAmount.toLocaleString()}
          </div>
        </div>

        {/* 통계 카드 4: 다음 레벨 미리보기 */}
        <div className="bg-indigo-600 rounded-2xl p-6 shadow-lg flex flex-col justify-center relative overflow-hidden">
          <div className="relative z-10">
            <span className="text-indigo-200 font-bold uppercase text-lg">Next Blind</span>
            <div className="text-4xl font-black mt-1">
              {nextBlind ? `${nextBlind.sb.toLocaleString()} / ${(nextBlind.sb * 2).toLocaleString()}` : 'END'}
            </div>
          </div>
          <div className="absolute right-[-20px] bottom-[-20px] text-8xl font-black text-indigo-500/30 -rotate-12">
            NEXT
          </div>
        </div>
      </div>

      {/* 최하단 안내 바 */}
      <div className="h-12 flex items-center justify-between px-6 bg-slate-900 rounded-xl border border-slate-800">
        <div className="flex items-center gap-4">
          <span className={`flex h-3 w-3 rounded-full ${dashboard.isRegistrationOpen ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <span className="font-bold text-sm uppercase tracking-widest">
            {dashboard.isRegistrationOpen ? `Registration Open (Until LV.${dashboard.rebuyUntil})` : 'Registration Closed'}
          </span>
        </div>
        <div className="text-slate-500 font-mono text-sm">
          Tournament ID: {tournamentId}
        </div>
      </div>
    </div>
  );
}