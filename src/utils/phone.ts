/**
 * 한국 전화번호 자동 하이픈 포맷터
 *
 *  - 휴대폰: 010-XXXX-XXXX / 011·016~019-XXX(X)-XXXX
 *  - 서울:   02-XXX(X)-XXXX
 *  - 그 외 지역번호(0??-…): 0AA-XXX(X)-XXXX
 *  - 0505/050X 평생번호도 같은 룰 적용
 *  - 전화번호가 아닌 임의 문자(예: 빈 문자열)도 안전하게 처리
 */

export function formatPhone(input: string | null | undefined): string {
  if (!input) return '';
  // 숫자만 추출
  const d = String(input).replace(/\D/g, '');
  if (d.length === 0) return '';

  // 02 (서울)
  if (d.startsWith('02')) {
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}-${d.slice(2)}`;          // 02-XXX
    if (d.length <= 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;  // 02-XXX-XXXX
    return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}`;        // 02-XXXX-XXXX
  }

  // 휴대폰 / 050X / 070 / 0505 / 일반 지역번호
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;            // 0AA-XXXX
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; // 0AA-XXX-XXXX
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 11)}`;          // 0AA-XXXX-XXXX
}

/** 화면에 표시할 때만 사용 — 비어있으면 '-' 반환 */
export function displayPhone(input: string | null | undefined): string {
  const f = formatPhone(input);
  return f || '-';
}

/** 저장할 때 숫자만 남기고 싶다면 */
export function digitsOnly(input: string | null | undefined): string {
  return String(input ?? '').replace(/\D/g, '');
}

/**
 * 주민등록번호 자동 하이픈 — 6자리 + - + 7자리
 *  e.g. 7704171055112 → 770417-1055112
 */
export function formatRRN(input: string | null | undefined): string {
  const d = String(input ?? '').replace(/\D/g, '').slice(0, 13);
  if (d.length <= 6) return d;
  return d.slice(0, 6) + '-' + d.slice(6);
}

/**
 * 계좌번호 자동 하이픈 — 은행마다 자릿수가 다르므로 3-x-x 패턴 추정.
 *  - 11자리:   3-3-5
 *  - 12자리:   3-4-5
 *  - 13자리:   3-6-4
 *  - 14자리 이상: 3-6-나머지
 *  - 그 외 (10자리 이하): 그대로
 *
 *  실 운영 시엔 은행별 패턴을 참조해야 하지만, 시연/사용성 측면에서는
 *  "숫자만 입력해도 보기 좋게 - 가 들어간다" 정도면 충분.
 */
export function formatAccount(input: string | null | undefined): string {
  const d = String(input ?? '').replace(/\D/g, '').slice(0, 16);
  if (d.length <= 3) return d;
  if (d.length <= 6) return d.slice(0, 3) + '-' + d.slice(3);
  // 7자리 이상: 앞 3 + 가운데 일부 + 뒤 일부
  if (d.length <= 11) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  if (d.length <= 13) return d.slice(0, 3) + '-' + d.slice(3, 9) + '-' + d.slice(9);
  return d.slice(0, 3) + '-' + d.slice(3, 9) + '-' + d.slice(9);
}
