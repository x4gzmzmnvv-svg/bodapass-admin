// FILE_VERSION 1777810050
/**
 * 4대보험 자격 사이클 추적
 *
 *  · 8일룰 — 한 달 8일 이상 근무 시 자격취득 (국민연금·건강보험)
 *  · 이탈 시 자격상실
 *  · 같은 사람이 입사·이탈 반복 시 자격취득/상실 사이클이 N번 발생 가능
 *
 *  법적 근거:
 *   · 국민연금법 시행령 제2조 — 1개월 8일 이상
 *   · 국민건강보험법 시행령 제9조 — 1개월 8일 이상
 *   · 고용·산재 — 일용근로내용 신고 (1일 단위)
 */

/** 보험 종류 */
export type InsuranceType = 'NP' | 'HI' | 'EI' | 'WC';

export const INSURANCE_TYPE_LABEL: Record<InsuranceType, string> = {
  NP: '국민연금',
  HI: '건강보험',
  EI: '고용보험',
  WC: '산재보험',
};

export const INSURANCE_TYPE_SHORT: Record<InsuranceType, string> = {
  NP: '국민',
  HI: '건강',
  EI: '고용',
  WC: '산재',
};

/** 자격 사이클 — 한 입사·이탈 짝의 자격취득/상실 기록 */
export interface InsuranceCycle {
  id: string;
  memberId: string;
  memberName: string;
  siteId: string;
  /** 자격취득일 (8일째 도달일) */
  acquireDate: string;
  /** 자격상실일 (이탈일) — 진행 중이면 미정 */
  loseDate?: string;
  /** 자격취득 신고 완료 시각 — 신고 후 사용자가 우리 시스템에 기록 */
  reportedAcquireAt?: string;
  /** 자격상실 신고 완료 시각 */
  reportedLoseAt?: string;
  /** 적용된 보험 (8일룰 = NP/HI, 1일룰 = EI/WC) */
  insuranceTypes: InsuranceType[];
}

/** 신고 대기 작업 (대시보드 알림 / 출력센터 표) */
export interface InsuranceFilingTask {
  id: string;
  memberId: string;
  memberName: string;
  siteId: string;
  siteName: string;
  /** 작업 유형 */
  type: 'ACQUIRE' | 'LOSE' | 'CHANGE';
  /** 자격 발생·변경 일자 (이 일자 기준 N일 이내 신고) */
  date: string;
  insuranceTypes: InsuranceType[];
  /** 마감일 — 일반적으로 자격 발생 후 익월 15일까지 (참고용) */
  dueBy: string;
  /** 자동 감지 사유 */
  reason: string;
}

/** 작업 유형 라벨 */
export const FILING_TYPE_LABEL: Record<InsuranceFilingTask['type'], string> = {
  ACQUIRE: '자격취득',
  LOSE: '자격상실',
  CHANGE: '내역변경',
};
