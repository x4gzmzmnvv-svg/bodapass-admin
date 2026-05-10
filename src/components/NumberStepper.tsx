import { InputHTMLAttributes } from 'react';
import './NumberStepper.css';

type StepperProps = {
  value: number | string;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'step' | 'min' | 'max' | 'className'
>;

/**
 * 숫자 인풋 + 우측 ∧/∨ 스테퍼.
 *  - 브라우저 기본 spinner 는 CSS 로 숨기고 커스텀 chevron 으로 대체.
 *  - 키보드 ↑/↓, 마우스 휠, 직접 입력 모두 동작 (native input 그대로).
 */
export function NumberStepper({
  value,
  onChange,
  step = 1,
  min,
  max,
  className,
  disabled,
  ...rest
}: StepperProps) {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? num : 0;

  const inc = () => {
    const next = safeNum + step;
    onChange(max !== undefined ? Math.min(max, next) : next);
  };
  const dec = () => {
    const next = safeNum - step;
    onChange(min !== undefined ? Math.max(min, next) : next);
  };

  return (
    <span className={'num-stepper' + (disabled ? ' is-disabled' : '') + (className ? ' ' + className : '')}>
      <input
        type="number"
        className="num-stepper__input"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '' || v === '-') {
            onChange(0);
            return;
          }
          const n = Number(v);
          if (Number.isFinite(n)) onChange(n);
        }}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        {...rest}
      />
      <span className="num-stepper__btns" aria-hidden="true">
        <button
          type="button"
          className="num-stepper__btn num-stepper__btn--up"
          onClick={inc}
          disabled={disabled}
          tabIndex={-1}
          aria-label="값 증가"
        >
          <svg width="9" height="6" viewBox="0 0 9 6" fill="none">
            <path d="M1 4.5 L4.5 1 L8 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="num-stepper__btn num-stepper__btn--down"
          onClick={dec}
          disabled={disabled}
          tabIndex={-1}
          aria-label="값 감소"
        >
          <svg width="9" height="6" viewBox="0 0 9 6" fill="none">
            <path d="M1 1.5 L4.5 5 L8 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
    </span>
  );
}
