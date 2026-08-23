/**
 * The small shared pieces: every colour, spacing and border here is a
 * Tailwind token from tailwind.config.js, never a literal.
 */
import * as React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Button({
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const base =
    'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    default: 'bg-raised text-ink hover:bg-line border border-line',
    primary: 'bg-accent-dim text-ink hover:bg-accent hover:text-bg border border-accent-dim',
    ghost: 'text-muted hover:text-ink hover:bg-raised',
    danger: 'bg-raised text-danger hover:bg-danger hover:text-bg border border-line',
  } as const;
  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted',
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted',
        className
      )}
      {...props}
    />
  );
}

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'accent' | 'ok' | 'warn';
  children: React.ReactNode;
}) {
  const tones = {
    muted: 'border-line text-muted',
    accent: 'border-accent-dim text-accent',
    ok: 'border-ok/40 text-ok',
    warn: 'border-warn/40 text-warn',
  } as const;
  return (
    <span className={cx('rounded border px-1.5 py-0.5 text-[11px] uppercase tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <RadixTooltip.Root delayDuration={300}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 rounded border border-line bg-raised px-2 py-1 text-xs text-ink shadow-lg"
        >
          {label}
          <RadixTooltip.Arrow className="fill-raised" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <RadixSelect.Root value={value || '__all__'} onValueChange={(v) => onChange(v === '__all__' ? '' : v)}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className="inline-flex min-w-[9rem] items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink"
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown size={14} className="text-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="z-50 overflow-hidden rounded-md border border-line bg-raised shadow-xl">
          <RadixSelect.Viewport className="max-h-72 p-1">
            <Item value="__all__">{placeholder}</Item>
            {options.map((option) => (
              <Item key={option.value} value={option.value}>
                {option.label}
              </Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

function Item({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <RadixSelect.Item
      value={value}
      className="flex cursor-pointer select-none items-center justify-between gap-3 rounded px-2 py-1.5 text-sm text-ink data-[highlighted]:bg-accent-dim data-[highlighted]:outline-none"
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator>
        <Check size={14} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

/** Bytes as a door listing shows them: whole KB, or bytes under 1 KB. */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} K`;
}
