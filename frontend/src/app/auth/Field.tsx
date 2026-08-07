/**
 * Carbon text-input — 회색 바탕, 사각 모서리, 아래 1px 실선. 포커스는
 * 파랑 2px 밑줄이다(`DESIGN.md` Elevation level 3). 테두리 굵기를 바꾸는
 * 대신 inset shadow로 그려서 포커스가 들어올 때 글자가 밀리지 않는다.
 *
 * placeholder가 아니라 `<label>`을 쓴다. placeholder는 입력을 시작하면
 * 사라져서, 무엇을 넣는 칸이었는지가 검토할 때 없어진다.
 *
 * 로그인과 회원가입이 같이 쓴다. 둘이 따로 갖고 있으면 포커스 표시 같은
 * 것이 한쪽에서만 바뀐다.
 */
export default function Field({
  name,
  label,
  type,
  autoComplete,
}: {
  name: string;
  label: string;
  type: string;
  autoComplete: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={name}
        className="text-[12px] leading-[1.33] tracking-[0.32px] text-[var(--ink-muted)]"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        className="h-12 w-full border-b border-[var(--ink)] bg-[var(--surface)] px-4 text-[16px] tracking-[0.16px] outline-none focus:shadow-[inset_0_-2px_0_var(--blue)]"
      />
    </div>
  );
}
