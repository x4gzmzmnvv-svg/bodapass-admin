/**
 * 회사 코드 — 「C-YY-NNNNNN」 형식
 *
 *  3계층 식별 체계 중 「표시 코드」 역할:
 *    · companyId   (내부 UUID·자동증분) — DB FK, 외부 노출 X
 *    · 사업자번호  (자연키)              — 자연 unique, 세무·법적 검증
 *    · 회사 코드   (이 모듈)             — UI·문서·검색용, 사용자 친화
 *
 *  형식:
 *    · C      : Company — 모든 회사 공통 prefix
 *    · YY     : 보다패스 등록 연도 (`26` = 2026)
 *    · NNNNNN : 6자리 시리얼 (companyId 해시 기반 결정적, 1~999,999)
 *
 *  영구 1회 발급, 변경 불가.
 *  자세한 정책: docs/identity-policy.md
 */

import type { Company } from '../api/site.types';

/** companyId 해시 → 6자리 시리얼 */
function hashSerial(companyId: string): string {
  let h = 0;
  for (const c of companyId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return String(h % 1_000_000).padStart(6, '0');
}

/**
 * 회사 코드 생성 — companyId + createdAt 기반.
 *  · 발급연도: createdAt에서 추출
 *  · 시리얼: companyId 해시 (결정적)
 *
 *  company.companyCode 가 이미 있으면 그대로 반환 (영구 불변)
 */
export function makeCompanyCode(company: Company): string {
  if (company.companyCode) return company.companyCode;
  const yy = company.createdAt
    ? company.createdAt.slice(2, 4)
    : new Date().getFullYear().toString().slice(2);
  const serial = hashSerial(company.id);
  return `C-${yy}-${serial}`;
}

/**
 * 사업자번호 포맷 — '1234567890' → '123-45-67890'.
 *  10자리 미만이거나 형식 불일치 시 companyId 기반 mock 생성 (시연용).
 */
export function formatBizNo(bizNo?: string, companyId?: string): string {
  let raw = (bizNo ?? '').replace(/\D/g, '');
  if (raw.length !== 10 && companyId) {
    let h = 0;
    for (const c of companyId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    raw = String(h).padStart(10, '0').slice(-10);
  }
  if (raw.length !== 10) return bizNo ?? '—';
  return `${raw.slice(0, 3)}-${raw.slice(3, 5)}-${raw.slice(5)}`;
}
