import type { CSSProperties } from 'react';

type Props = {
  l: string;
  r: string;
  lStyle?: CSSProperties;
  rStyle?: CSSProperties;
};

export function DetailRow({ l, r, lStyle, rStyle }: Props) {
  return (
    <div className="detail-row">
      <span className="l" style={lStyle}>{l}</span>
      <span className="r" style={rStyle}>{r}</span>
    </div>
  );
}
