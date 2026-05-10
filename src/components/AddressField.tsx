import React from 'react';
// FILE_VERSION 1777810030
/**
 * AddressField — 모든 주소 입력 필드의 표준 디자인
 *
 *  · 「우편번호」 버튼 + 주소 인풋 한 줄 (사용자가 보던 「소재지(현장명)」 디자인)
 *  · 클릭 시 Daum 우편번호 팝업 → 콜백으로 address + zonecode 전달
 *  · readOnly 모드: 버튼 비활성, 인풋 readOnly
 *  · 단독 사용 가능 (FormField 등 외부 라벨과 같이 사용)
 *
 * 사용 예
 *   <AddressField
 *     value={form.address}
 *     onSelect={({ address, zonecode }) => {
 *       set('address', address);
 *       set('zipCode', zonecode);
 *     }}
 *   />
 *
 *   // 우편번호도 같이 표시하고 싶으면 zonecode 표시 prop 사용:
 *   <AddressField
 *     zonecode={form.zipCode}
 *     value={form.address}
 *     onSelect={...}
 *     showZonecode
 *   />
 */

import { openPostcode, type PostcodeResult } from '../utils/postcode';
import './AddressField.css';

interface Props {
  value: string;
  /** 선택한 주소 콜백 */
  onSelect: (result: PostcodeResult) => void;
  /** 사용자가 직접 입력한 주소 변경 (선택적 — 도로명 외 임의 입력 허용) */
  onChange?: (next: string) => void;
  /** 우편번호 — showZonecode 가 true면 별도 박스로 표시 */
  zonecode?: string;
  showZonecode?: boolean;
  /** placeholder */
  placeholder?: string;
  /** 읽기 전용 */
  readOnly?: boolean;
  /** 버튼 라벨 (기본 '우편번호') */
  buttonLabel?: React.ReactNode;
  /** 큰 인풋 (소재지·현장명 등 — 굵게) */
  big?: boolean;
  /** 추가 className */
  className?: string;
}

export function AddressField({
  value,
  onSelect,
  onChange,
  zonecode,
  showZonecode = false,
  placeholder = '주소를 검색하거나 입력하세요',
  readOnly = false,
  buttonLabel = '우편번호',
  big = false,
  className = '',
}: Props) {
  function handleSearch() {
    openPostcode((data) => {
      onSelect(data);
    });
  }

  return (
    <span className={'addr-field' + (className ? ' ' + className : '') + (big ? ' addr-field--big' : '')}>
      {showZonecode && zonecode && (
        <span className="addr-field__zone">{zonecode}</span>
      )}
      <button
        type="button"
        className="addr-field__btn"
        disabled={readOnly}
        onClick={handleSearch}
        title="다음(Daum) 우편번호 검색"
      >
        {buttonLabel}
      </button>
      <input
        type="text"
        className={'addr-field__input' + (big ? ' addr-field__input--big' : '')}
        value={value}
        readOnly={readOnly || !onChange}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </span>
  );
}
