'use client';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function Keypad({
  onDigit,
  onClear,
}: {
  onDigit: (digit: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onDigit(k)}
          className="rounded border border-tb-line bg-tb-panel py-4 font-mono text-2xl text-tb-ink"
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="rounded border border-tb-line bg-tb-panel py-4 text-tb-muted"
      >
        지우기
      </button>
      <button
        type="button"
        onClick={() => onDigit('0')}
        className="rounded border border-tb-line bg-tb-panel py-4 font-mono text-2xl text-tb-ink"
      >
        0
      </button>
    </div>
  );
}
