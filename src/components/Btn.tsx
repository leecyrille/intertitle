import type { ReactNode } from "react";

interface Props {
  onClick?: () => void;
  children: ReactNode;
  /** Shown in the tooltip, e.g. "I" or "Ctrl+O" */
  shortcut?: string;
  tip?: string;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  active?: boolean;
  className?: string;
  title?: string;
}

/** A button whose tooltip shows what it does and its keyboard shortcut. */
export default function Btn({ onClick, children, shortcut, tip, disabled, primary, danger, small, active, className }: Props) {
  const cls = ["btn", primary ? "primary" : "", danger ? "danger" : "", small ? "small" : "", active ? "active" : "", className ?? ""].join(" ");
  return (
    <span className="tipwrap">
      <button className={cls} onClick={onClick} disabled={disabled} type="button">
        {children}
      </button>
      {(tip || shortcut) && (
        <span className="tip" role="tooltip">
          {tip}
          {shortcut && <kbd>{shortcut}</kbd>}
        </span>
      )}
    </span>
  );
}
