import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import './WorkCloseHeader.css';

/**
 * 출역·노무마감 그룹의 4페이지 공통 헤더.
 *
 *  스텝퍼:  ① 인증 → ② 일일출역확정 → ③ 월 공수마감 → ④ 노무비 마감
 *  탭바:    같은 4단계를 큰 카드 버튼으로 노출 — 화면 전환의 메인 네비.
 *
 *  · 현재 단계는 「숨쉬기」 애니메이션 (CSS @keyframes breath) 으로 강조.
 *  · 탭 클릭 시 해당 라우트로 이동 — 사실상 한 화면에서 4단계가 흐르는 UX.
 *  · 다음 단계로 이동하는 「→ 다음 단계」 버튼은 각 페이지에서 별도 제공.
 */
export type WorkCloseStep = 'auth' | 'daily' | 'gongsu' | 'wage';

const STEPS: Array<{
  key: WorkCloseStep;
  label: string;
  num: string;
  sub: string;
  to: string;
}> = [
  { key: 'auth',   num: '①', label: '인증관리',     sub: '이 출근 기록을 믿을 수 있는가',   to: '/auth-mgmt' },
  { key: 'daily',  num: '②', label: '일일 출역확정', sub: '오늘 몇 공수로 인정할 것인가',     to: '/daily-confirm' },
  { key: 'gongsu', num: '③', label: '월 공수마감',   sub: '이번 달 공수 잠그기',              to: '/gongsu-close' },
  { key: 'wage',   num: '④', label: '노무비 마감',   sub: '지급액·공제·실지급 확정',           to: '/wage-close' },
];

interface Props {
  active: WorkCloseStep;
  /** siteId 가 있으면 라우트 이동 시 ?siteId=… 파라미터로 전달 (현장 자동 선택) */
  siteId?: string;
  /**
   * 실제 워크플로우 진행률 — 0~4 단계 중 「몇 단계까지 끝났는가」.
   * 단계가 끝난 만큼 다음 연결선이 채워짐.
   */
  progress?: number;
  /**
   * 인증관리 → 일일출역확정 사이 「일자별 진행률」 (0~100).
   * (호환 유지용 — 신규 코드에선 currentStepProgress 사용 권장)
   */
  dailyProgress?: number;
  /**
   * 「현재 활성 단계」의 처리율 (0~100). completedCount 다음 연결선을 이만큼 채움.
   * · 인증관리: 오늘 인증 처리율
   * · 일일출역확정: 월간 일자 확정율
   * · 월 공수마감: 공수 마감 비율
   * · 노무비 마감: 노무비 처리율
   */
  currentStepProgress?: number;
  /**
   * 활성 단계 라벨 아래 노출할 진행 텍스트 — 「N/M 일 확정 (X%)」 같이.
   * 4개 페이지 모두 동일한 위치/톤으로 노출 → 일관성 유지.
   */
  currentStepLabel?: ReactNode;
  /** 스텝퍼 바 우측에 노출할 페이지별 액션 (출역확정 대기 칩 / MonthPicker 등) */
  rightActions?: ReactNode;
}

export function WorkCloseHeader({
  active, siteId, progress, dailyProgress, currentStepProgress, currentStepLabel, rightActions,
}: Props) {
  const navigate = useNavigate();
  function go(to: string) {
    const url = siteId && siteId !== 'ALL'
      ? to + '?siteId=' + encodeURIComponent(siteId)
      : to;
    navigate(url);
  }

  // 진행률 — prop 의 「몇 단계까지 완료」만 사용 (active = 현재 보고 있는 페이지는 시각화에서 제외)
  const completedCount = typeof progress === 'number'
    ? Math.min(Math.max(progress, 0), STEPS.length)
    : 0;
  // active prop 은 라우팅 용도로만 사용 (스타일링 X)
  void active;

  // 신규 prop currentStepProgress 우선, 없으면 legacy dailyProgress
  const stepPct = (typeof currentStepProgress === 'number')
    ? Math.max(0, Math.min(100, currentStepProgress))
    : (typeof dailyProgress === 'number' ? Math.max(0, Math.min(100, dailyProgress)) : null);

  // 일일출역확정 → 월공수마감 선 자동 채움 — 한 달 기준 day-of-month 비율
  // (해당 구간에 stepPct 가 명시되지 않은 경우만 자동 산출)
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonthPct = Math.min(100, Math.round((today.getDate() / daysInMonth) * 100));

  // 각 연결선의 채움 비율 (0~100)
  // 0: 인증 → 일일출역확정
  // 1: 일일출역확정 → 월공수마감 (day-of-month 자동 채움)
  // 2: 월공수마감 → 노무비 마감
  function fillPercent(connectorIdx: number): number {
    if (connectorIdx < completedCount) return 100;
    if (connectorIdx > completedCount) {
      // 완료되지 않은 단계 사이의 선 — 단, 일일→월공수 구간은 day-of-month 자동 채움
      if (connectorIdx === 1) return dayOfMonthPct;
      return 0;
    }
    // 현재 활성 단계 다음 연결선
    if (connectorIdx === 1 && stepPct === null) return dayOfMonthPct;
    if (stepPct !== null) return stepPct;
    return 0;
  }

  return (
    <div className="wch">
      <nav className="wch__progress" aria-label="출역·노무마감 진행 흐름">
        {/* 좌측: 점 + 라벨 + 연결선 — 4단계 */}
        <div className="wch__progress-steps">
          {STEPS.map((s, i) => {
            const isCompleted = i < completedCount;
            const isPending = !isCompleted;
            // 숨쉬기는 「처리가 필요한 다음 단계」 = 첫 미완료 단계 한 곳에만 적용
            const isFirstPending = isPending && i === completedCount;
            const stateCls = isCompleted
              ? 'is-completed'
              : isFirstPending ? 'is-active-pending' : 'is-pending';
            // 진행 중 단계의 라벨 — 첫 미완료 단계에만 노출
            const showStepLabel = isFirstPending && (currentStepLabel || stepPct !== null);
            // 현재 페이지 인디케이터 — 사용자가 보고 있는 페이지에만 하단 얇은 파란줄
            const isActivePage = s.key === active;
            return (
              <div key={s.key} className={'wch__progress-row' + (isActivePage ? ' is-active-page' : '')}>
                <button
                  type="button"
                  className={'wch__progress-step ' + stateCls + (isActivePage ? ' is-active-page' : '')}
                  onClick={() => go(s.to)}
                  title={s.label}
                >
                  <span className="wch__progress-dot" aria-hidden>
                    {isCompleted ? '✓' : i + 1}
                  </span>
                  <span className="wch__progress-label">{s.label}</span>
                  {/* % 진행 라벨(.wch__progress-pct) — 사용자 요청으로 제거.
                   *  진행률은 단계 사이의 연결선 채움(fillPercent) 으로만 표시. */}
                </button>
                {i < STEPS.length - 1 && (() => {
                  const pct = fillPercent(i);
                  const isPartial = pct > 0 && pct < 100;
                  return (
                    <span className={'wch__progress-line' + (isPartial ? ' is-partial' : pct === 100 ? ' is-full' : '')} aria-hidden>
                      <span
                        className="wch__progress-line-fill"
                        style={{ width: pct + '%' }}
                      />
                    </span>
                  );
                })()}
              </div>
            );
          })}
        </div>
        {/* 우측: 페이지 액션 슬롯 */}
        {rightActions && <div className="wch__progress-actions">{rightActions}</div>}
      </nav>
    </div>
  );
}
