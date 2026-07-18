'use client';

import { useState } from 'react';
import { createTournamentAction } from './action';

export default function TournamentForm({ storeId, savedBlinds }: { storeId: string, savedBlinds: any[] }) {
  const [selectedBlindId, setSelectedBlindId] = useState<string>('new');
  const [blindName, setBlindName] = useState('기본 블라인드');
  const [structure, setStructure] = useState([
    { lv: 1, sb: 100, ante: false, duration: 5 }
  ]);

  const addLevel = () => {
    const last = structure[structure.length - 1];
    setStructure([...structure, { lv: last.lv + 1, sb: last.sb * 2, ante: false, duration: 5 }]);
  };

  const handleLevelChange = (index: number, field: string, value: any) => {
    const newStructure = [...structure];
    newStructure[index] = { ...newStructure[index], [field]: value };
    setStructure(newStructure);
  };

  async function handleSubmit(formData: FormData) {
    if (selectedBlindId === 'new') {
      const blindData = { name: blindName, structure, storeId };
      formData.append('blindData', JSON.stringify(blindData));
    } else {
      formData.append('blindId', JSON.stringify(selectedBlindId));
    }

    const result = await createTournamentAction(storeId, formData);
    if (result?.error) alert(result.error);
    else alert('대회가 성공적으로 개최되었습니다.');
  }

  return (
    <form action={handleSubmit} className="p-6 space-y-8 bg-white rounded-2xl shadow-lg border border-slate-200">

      {/* 1. 대회 정보 설정 (입력 글씨 색상 강화) */}
      <section className="space-y-4">
        <h3 className="text-lg font-bold text-slate-900 border-l-4 border-indigo-600 pl-3">1. 대회 기본 정보</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs font-bold text-slate-600 ml-1">대회 명칭</label>
            <input name="name" placeholder="대회 이름을 입력하세요"
              className="w-full border-2 border-slate-200 p-3 rounded-xl text-slate-900 font-medium focus:border-indigo-500 outline-none placeholder:text-slate-400" required />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 ml-1">참가비 (₩)</label>
            <input name="entryFee" type="number" placeholder="0"
              className="w-full border-2 border-slate-200 p-3 rounded-xl text-slate-900 font-medium focus:border-indigo-500 outline-none" required />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 ml-1">시작 스택</label>
            <input name="startStack" type="number" placeholder="20000"
              className="w-full border-2 border-slate-200 p-3 rounded-xl text-slate-900 font-medium focus:border-indigo-500 outline-none" required />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 ml-1">레지 마감 (Level)</label>
            <input name="rebuyUntil" type="number" placeholder="9"
              className="w-full border-2 border-slate-200 p-3 rounded-xl text-slate-900 font-medium focus:border-indigo-500 outline-none" required />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 ml-1">ITM 인원</label>
            <input name="itmCount" type="number" placeholder="1"
              className="w-full border-2 border-slate-200 p-3 rounded-xl text-slate-900 font-medium focus:border-indigo-500 outline-none" required />
          </div>
        </div>
      </section>

      {/* 2. 블라인드 설정 */}
      <section className="space-y-4 pt-4 border-t border-slate-200">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-bold text-slate-900 pl-3">2. 블라인드 구조</h3>
          <select
            value={selectedBlindId}
            onChange={(e) => setSelectedBlindId(e.target.value)}
            className="border-2 border-indigo-200 p-2 rounded-lg text-sm font-bold text-indigo-700 bg-indigo-50 focus:ring-2 ring-indigo-300 outline-none"
          >
            <option value="new">+ 직접 새로 만들기</option>
            {savedBlinds.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {selectedBlindId === 'new' ? (
          <div className="bg-slate-50 p-5 rounded-2xl border-2 border-slate-100 space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-600 ml-1">구조 명칭 저장</label>
              <input
                value={blindName}
                onChange={(e) => setBlindName(e.target.value)}
                className="w-full p-3 rounded-xl border-2 border-white text-slate-900 font-bold shadow-sm focus:border-indigo-400 outline-none"
              />
            </div>

            <div className="max-h-72 overflow-y-auto space-y-2 pr-2">
              <div className="grid grid-cols-5 gap-2 px-2 text-[10px] font-black text-slate-400 uppercase">
                <div className="text-center">Level</div>
                <div className="col-span-2 text-center">Small Blind</div>
                <div className="text-center">Ante</div>
                <div className="text-center">Min</div>
              </div>
              {structure.map((item, i) => (
                <div key={i} className="grid grid-cols-5 gap-2 items-center bg-white p-2 rounded-xl border border-slate-200 shadow-sm">
                  <span className="text-center font-black text-indigo-600">Lv.{item.lv}</span>
                  <input type="number" value={item.sb} onChange={(e) => handleLevelChange(i, 'sb', +e.target.value)}
                    className="col-span-2 text-center text-slate-900 font-bold p-1 bg-slate-50 rounded-lg outline-none focus:bg-white focus:ring-1 ring-indigo-400" />
                  <div className="flex justify-center">
                    <input type="checkbox" checked={item.ante} onChange={(e) => handleLevelChange(i, 'ante', e.target.checked)}
                      className="w-5 h-5 accent-indigo-600" />
                  </div>
                  <input type="number" value={item.duration} onChange={(e) => handleLevelChange(i, 'duration', +e.target.value)}
                    className="text-center text-slate-900 font-bold p-1 bg-slate-50 rounded-lg outline-none focus:bg-white focus:ring-1 ring-indigo-400" />
                </div>
              ))}
            </div>
            <button type="button" onClick={addLevel}
              className="w-full py-3 bg-white border-2 border-dashed border-slate-300 rounded-xl text-slate-500 font-bold hover:text-indigo-600 hover:border-indigo-400 transition-all">
              + 다음 레벨 추가
            </button>
          </div>
        ) : (
          <div className="p-10 text-center bg-indigo-600 rounded-2xl shadow-inner shadow-indigo-900/20">
            <p className="text-white font-bold text-lg">기존 구조 사용 중</p>
            <p className="text-indigo-100 text-sm opacity-80 mt-1">
              "{savedBlinds.find(b => b.id === selectedBlindId)?.name}"가 적용됩니다.
            </p>
          </div>
        )}
      </section>

      <button type="submit" className="w-full bg-slate-900 hover:bg-black text-white py-5 rounded-2xl font-black text-xl shadow-xl transition-all active:scale-[0.97]">
        대회 개최 확정
      </button>
    </form>
  );
}