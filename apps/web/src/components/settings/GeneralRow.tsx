function GeneralRow({
  title,
  hint,
  children,
}: {
  title: string;
  /** Optional status line (e.g. current engine version). Explanatory copy is not shown. */
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--color-ink)]">{title}</div>
        {hint && (
          <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">{hint}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export { GeneralRow };