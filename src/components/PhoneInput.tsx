import type { InputHTMLAttributes } from 'react';
import { formatPhone } from '../utils/phone';

/**
 * 전화번호 전용 입력 — 사용자가 숫자만 쳐도 자동으로 010-XXXX-XXXX 형태로 하이픈을 채워준다.
 *
 * - value 는 그대로 string (이미 포맷된 값) 으로 보관해도 OK
 * - onChange 는 포맷이 적용된 string 을 돌려준다
 * - 그 외 input 속성은 그대로 통과 (className, placeholder, disabled, readOnly 등)
 */
export function PhoneInput({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  return (
    <input
      {...rest}
      type="tel"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(formatPhone(e.target.value))}
    />
  );
}
