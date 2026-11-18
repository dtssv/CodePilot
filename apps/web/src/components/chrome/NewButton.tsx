import { PlusIcon } from "../Icons.js";

export function NewButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12.5px] font-medium text-[var(--color-ink)] shadow-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="cp-brand-gradient flex h-5 w-5 items-center justify-center rounded-md text-white">
        <PlusIcon className="h-3 w-3" />
      </span>
      {label}
    </button>
  );
}