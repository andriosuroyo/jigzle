import type { ReactNode } from 'react';

type Props = {
  band: string;
  children: ReactNode;
  bodyClassName?: string;
};

export function Section({ band, children, bodyClassName }: Props) {
  return (
    <div className="section">
      <div className="section-band">{band}</div>
      <div className={bodyClassName ?? 'section-body'}>{children}</div>
    </div>
  );
}
