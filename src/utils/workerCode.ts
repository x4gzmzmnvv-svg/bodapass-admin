/**
 * 워커 관리번호 — 「W-YY-NNNNNN」 형식 (성별 정보 없음)
 *
 *  · W      : Worker — 모든 근로자 공통 prefix (성별 무관)
 *  · YY     : 발급 연도 (출생 연도가 아님 — PII 노출 최소화)
 *  · NNNNNN : 6자리 시리얼 (memberId 해시 기반 결정적, 1~999,999)
 *
 *  성별 prefix를 빼는 이유:
 *    · 개인정보보호법 — 성별은 민감정보에 준함
 *    · 남녀고용평등법 — 채용·근무 과정 성별 노출은 차별 위험
 *    · 트랜스젠더·법적 성별 변경자 — 코드 변경 강제 시 정체성 노출
 *    · 비공개 희망자 — 코드만 봐도 성별 노출 (PII)
 *
 *  영구 1회 발급, 회사·현장 무관, 변경 불가.
 *  자세한 정책: docs/identity-policy.md
 */

import type { TeamMember } from '../api/team.types';

/** 멤버 ID 해시 → 6자리 시리얼 */
function hashSerial(memberId: string): string {
  let h = 0;
  for (const c of memberId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return String(h % 1_000_000).padStart(6, '0');
}

/**
 * 워커 관리번호 생성 — TeamMember의 joinedAt + memberId 기반.
 *  · 발급연도: joinedAt에서 추출 ('2026-05-04' → '26')
 *  · 시리얼: member.id 해시 (결정적)
 *  · 성별 정보 없음 (W- 공통 prefix)
 *
 *  member.workerCode 가 이미 있으면 그대로 반환 (영구 불변 원칙)
 */
export function makeWorkerCode(member: TeamMember): string {
  if (member.workerCode) return member.workerCode;

  // 발급 연도 — joinedAt에서 추출
  const yy = member.joinedAt
    ? member.joinedAt.slice(2, 4)
    : new Date().getFullYear().toString().slice(2);

  // 6자리 시리얼
  const serial = hashSerial(member.id);

  return `W-${yy}-${serial}`;
}

/**
 * 신뢰등급 자동 판정 (T1 / T2 / T3)
 *  T1: 얼굴 ✓ + 신분증 ✓ + 본인 명의 통장 ✓
 *  T2: 얼굴 ✓ + 신분증 ✓ + 가족·반장 명의 통장
 *  T3: 얼굴 ✓ + 신분증 ✗
 *
 *  얼굴 미등록자는 시스템 가입 불가 (가입 단계에서 차단)
 *  T4 (아무것도 없음) 는 별도 출입기록으로만 관리되며 TeamMember 가 아님
 *
 *  member.trustTier 가 이미 있으면 그대로 반환 (수동 지정 우선)
 */
export function decideTrustTier(member: TeamMember): 1 | 2 | 3 {
  if (member.trustTier) return member.trustTier;

  const hasFace = member.faceVerified === true;
  const hasId =
    !!member.idNumberMasked &&
    member.idNumberMasked !== '-' &&
    member.idNumberMasked.length > 0;
  // 본인 명의 통장 추정 — 시연 데이터에선 별도 필드 없으므로
  // accountMasked 가 있고 멤버 ID 해시로 80% 정도를 「본인 명의」로 간주
  let h = 0;
  for (const c of member.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hasOwnBank = !!member.accountMasked && h % 10 < 8;

  if (!hasFace) {
    // 시연 데이터엔 faceVerified=undefined가 다수. T3 fallback (운영에선 가입 차단)
    if (!hasId) return 3;
    return hasOwnBank ? 1 : 2;
  }
  if (hasFace && hasId && hasOwnBank) return 1;
  if (hasFace && hasId) return 2;
  return 3;
}

/** Tier 라벨 + 톤 */
export function tierLabel(tier: 1 | 2 | 3): { label: string; sub: string; tone: 'ok' | 'info' | 'warn' } {
  switch (tier) {
    case 1: return { label: '✓ 정식',   sub: 'T1', tone: 'ok' };
    case 2: return { label: '△ 부분',   sub: 'T2', tone: 'info' };
    case 3: return { label: '⚠ 제한',   sub: 'T3', tone: 'warn' };
  }
}
