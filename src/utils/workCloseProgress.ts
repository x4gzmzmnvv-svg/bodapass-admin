/**
 * 출역·노무마감 4단계 워크플로우의 「실제 진행률」 산출.
 *
 * 4페이지 모두 같은 함수를 호출 → WorkCloseHeader 의 펄스가 실제 진행상태에 일관되게 머무름.
 *
 * 반환값:
 *   0 — 인증 단계 미완 (수동 / GPS 오류 존재)
 *   1 — 인증 끝, 일일출역확정 미완
 *   2 — 일일출역확정 끝, 월 공수마감 미완
 *   3 — 월 공수마감 끝, 노무비 마감 미완
 *   4 — 전부 끝 (펄스 없음)
 */

import type { TodayAttendance } from '../api/attendance.types';

/** 진행률 계산용 — monthClose 의 최소 필드만 받는 느슨한 타입 */
export interface MonthCloseLite {
  status?: 'OPEN' | 'CLOSED';
  attStage?: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';
  wageStage?: 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';
}

export function computeWorkCloseProgress(args: {
  today?: TodayAttendance | null;
  monthClose?: MonthCloseLite | null;
}): number {
  const { today, monthClose } = args;

  // step 1: 인증관리
  if (today && (today.members?.length ?? 0) > 0) {
    const allOk = (today.members ?? []).every((tm) => {
      if (!tm.record) return true;
      if (tm.record.checkInMethod === 'MANUAL') return false;
      if (tm.record.geofenceResult && tm.record.geofenceResult !== 'INSIDE') return false;
      return true;
    });
    if (!allOk) return 0;
  }

  // step 2: 일일출역확정 — attStage 가 OPEN 이면 미완
  if (!monthClose) return 1;
  if (monthClose.attStage === 'OPEN') return 1;

  // step 3: 월 공수마감 — attStage HQ_CONFIRMED 또는 status CLOSED 면 통과
  if (monthClose.attStage !== 'HQ_CONFIRMED' && monthClose.status !== 'CLOSED') return 2;

  // step 4: 노무비 마감 — wageStage 가 HQ_CONFIRMED 이상이면 통과
  const ws = monthClose.wageStage;
  if (ws === 'OPEN' || ws === 'SITE_CLOSED') return 3;

  // 전부 끝
  return 4;
}
