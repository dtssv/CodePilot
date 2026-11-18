export function Field({
  label,
  value,
  onChange,
  mono,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  mono?: boolean;
  type?: string;
  placeholder?: string;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="cp-eyebrow">{label}</span>
      <input
        type={type}
        className={`cp-input mt-0.5 w-full ${mono ? "font-mono text-[12px]" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}