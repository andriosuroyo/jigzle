import type { ReactNode } from 'react';

type Props = {
  label: string;
  required?: boolean;
  bold?: boolean;
  hint?: ReactNode;
  children: ReactNode;
};

export function Field({ label, required, bold, hint, children }: Props) {
  const labelCls = ['field-label', required ? 'req' : '', bold ? 'bold' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <span className={labelCls}>{label}</span>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
