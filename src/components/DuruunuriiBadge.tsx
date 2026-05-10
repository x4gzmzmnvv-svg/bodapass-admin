/**
 * 두루누리 지원 뱃지 — 「두루누리 80%」 / 「두루누리 40%」 / 「대상 외」 표시
 *
 *  · 인력관리 행, 노무비 마감 표 등에 부착
 *  · 호버 시 자세한 안내 (사유, 월 예상 지원금)
 */

import type { TeamMember } from '../api/team.types';
import {
  checkMemberEligibility,
  estimateMonthlySupport,
} from '../utils/duruunuri';
import './DuruunuriiBadge.css';

interface Props {
  member: TeamMember;
  /** 멤버의 월 보수 추정 (원) — 노무비 마감 페이지에선 실제 합계, 그 외에는 일당 × 22 */
  monthlyWage: number;
  /** 사업장 상시근로자 수 — 10명 미만 사업장만 대상 */
  siteStaffCount: number;
  /** 컴팩트 모드 — 표 안에 들어갈 때 사용 (작은 사이즈) */
  compact?: boolean;
}

export function DuruunuriiBadge({ member, monthlyWage, siteStaffCount, compact }: Props) {
  const elig = checkMemberEligibility(member, monthlyWage, siteStaffCount);
  if (!elig.eligible) {
    // 대상 외 — 작은 회색 표시 (compact 모드에서만 보이고 일반 모드에선 생략)
    if (compact) return null;
    return (
      <span
        className="duru-badge duru-badge--off"
        title={`두루누리 대상 외 — ${elig.reason}`}
      >
        대상 외
      </span>
    );
  }
  const est = estimateMonthlySupport(monthlyWage, elig.isNew);
  return (
    <span
      className={'duru-badge ' + (elig.isNew ? 'duru-badge--new' : 'duru-badge--exist')
        + (compact ? ' duru-badge--compact' : '')}
      title={[
        `두루누리 ${elig.isNew ? '신규' : '기존'} 가입자 ${(est.ratio * 100).toFixed(0)}% 지원`,
        `월 보험료 ${est.totalPremium.toLocaleString()}원`,
        `→ 정부 지원금 ${est.supportAmount.toLocaleString()}원`,
        elig.reason,
      ].join('\n')}
    >
      <span className="duru-badge__icon" aria-hidden>★</span>
      <span className="duru-badge__label">
        두루누리 {(est.ratio * 100).toFixed(0)}%
      </span>
    </span>
  );
}
