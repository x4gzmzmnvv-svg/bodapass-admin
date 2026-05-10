import { ChangeEvent, InputHTMLAttributes, ReactNode, forwardRef, useId } from 'react';
import './Field.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  required?: boolean;
  /** 라벨 옆 작은 부가 설명 — `(...)` 로 감싸서 노출 */
  hint?: string;
  error?: ReactNode;
  /** error 를 라벨 옆에 빨간 `(...)` 로 노출 (박스 아래 별도 메시지 X) */
  errorInLabel?: boolean;
  helper?: ReactNode;
  trailing?: ReactNode;
  /** value 보정(format) — onChange 직전에 변환 */
  formatter?: (raw: string) => string;
  onChange?: (value: string, e: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * 라벨 + input + helper/error 가 묶인 폼 필드.
 * 회원가입·팀원 등록 등 다수 페이지에서 재사용.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  {
    label,
    required,
    hint,
    error,
    errorInLabel,
    helper,
    trailing,
    formatter,
    onChange,
    id,
    className = '',
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const cls = ['field', error ? 'field--error' : '', className].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <label htmlFor={inputId} className="field__label">
        {label}
        {required && <span className="field__required">*</span>}
        {hint && <span className="field__hint"> ({hint})</span>}
        {error && errorInLabel && (
          <span className="field__err-inline"> ({error})</span>
        )}
      </label>

      <div className="field__row">
        <input
          ref={ref}
          id={inputId}
          className="field__input"
          onChange={(e) => {
            const v = formatter ? formatter(e.target.value) : e.target.value;
            if (formatter && v !== e.target.value) {
              e.target.value = v;
            }
            onChange?.(v, e);
          }}
          {...rest}
        />
        {trailing && <div className="field__trailing">{trailing}</div>}
      </div>

      {/* errorInLabel 일 땐 박스 아래 메시지 생략 (라벨 옆에 이미 표시) */}
      {((error && !errorInLabel) || helper) && (
        <p className={`field__msg ${error ? 'field__msg--error' : ''}`}>{error ?? helper}</p>
      )}
    </div>
  );
});
