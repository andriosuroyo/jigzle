'use client';

// PR144 — the one search bar. A single styled search field (magnifier icon + pill input + built-in
// clear ×) used by every list search across the system, matching the address-autofill type-ahead's
// look. Purely presentational: the parent owns the value + filtering, exactly like the plain inputs
// it replaces.

import { forwardRef } from 'react';

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear?: () => void; // extra work on clear (e.g. drop results + refocus); the value reset is built in
};

const SearchInput = forwardRef<HTMLInputElement, Props>(function SearchInput(
  { value, onChange, placeholder, disabled, autoFocus, ariaLabel, className, onKeyDown, onClear },
  ref
) {
  return (
    <div className={`search-input ${className ?? ''}`}>
      <svg className="search-input-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
        <path d="M13.5 13.5 L17.5 17.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        type="search"
        inputMode="search"
        aria-label={ariaLabel ?? placeholder ?? 'Search'}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {value && !disabled && (
        <button
          type="button"
          className="search-input-clear"
          aria-label="Clear search"
          onClick={() => { onChange(''); onClear?.(); }}
        >
          ×
        </button>
      )}
    </div>
  );
});

export default SearchInput;
