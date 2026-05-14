import { fmtRp } from '@jigzle/lib';

type Props = {
  marker: string;
  desc: string;
  sub: string;
  val: number;
  cls?: string;
};

export function BreakdownRow({ marker, desc, sub, val, cls }: Props) {
  return (
    <div className={`brk-row${cls ? ' ' + cls : ''}`}>
      <span className="marker">{marker}</span>
      <span className="desc">
        {desc}
        {sub && <span className="sub">{sub}</span>}
      </span>
      <span className="val">{fmtRp(val)}</span>
    </div>
  );
}
