// Small form primitives shared by the premium bot configuration panels.
//
// Every field states its unit and its bound, because an operator editing a live
// trading configuration should never have to guess what a number means.
import type { ReactNode } from 'react';
import { Switch } from '@/components/ui/switch';

export const inputClass = 'h-9 w-full rounded-lg border border-input bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-primary';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint ? <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  disabled,
  testId,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className={`${inputClass} disabled:opacity-60`}
      data-testid={testId}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  options,
  disabled,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`${inputClass} disabled:opacity-60`}
      data-testid={testId}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function ToggleField({ label, hint, checked, onChange, testId }: { label: string; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-bold">{label}</div>
        {hint ? <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  );
}

/** A titled group of configuration fields, used inside the collapsible panel. */
export function ConfigGroup({ title, description, children, columns = 4 }: { title: string; description?: string; children: ReactNode; columns?: 2 | 3 | 4 }) {
  const gridClass = columns === 2 ? 'sm:grid-cols-2' : columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4';
  return (
    <div className="rounded-lg border border-border bg-background/30 p-3">
      <div className="text-xs font-bold">{title}</div>
      {description ? <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{description}</p> : null}
      <div className={`mt-3 grid gap-3 ${gridClass}`}>{children}</div>
    </div>
  );
}
