type Props = {
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
};

export function Headline({ primaryLabel, primaryValue, secondaryLabel, secondaryValue }: Props) {
  return (
    <div className="headline">
      <div className="row primary">
        <span className="label">{primaryLabel}</span>
        <span className="value">{primaryValue}</span>
      </div>
      <div className="row secondary">
        <span className="label">{secondaryLabel}</span>
        <span className="value">{secondaryValue}</span>
      </div>
    </div>
  );
}
