/**
 * InsuranceDeadlineAlert — 대시보드 상단 4대보험 신고 마감 알림 카드
 *
 *  · 마감 임박/지연 항목이 있을 때만 노출
 *  · 클릭 → 4대보험 페이지로 점프
 *  · 항목별 D-day, 현장명, 인원, 신고 종류 표시
 */

import { useNavigate } from 'react-router-dom';
import { useInsuranceDeadlines } from '../hooks/useInsuranceDeadlines';
import type { DeadlineItem } from '../utils/insuranceDeadlines';
import './InsuranceDeadlineAlert.css';

export function InsuranceDeadlineAlert() {
  const { items } = useInsuranceDeadlines();
  const navigate = useNavigate();

  // 표시할 항목 — 마감 7일 이내 + 지연된 것만 (안전한 것은 숨김)
  const visible = items.filter((i) => i.severity !== 'safe').slice(0, 5);
  if (visible.length === 0) return null;

  const overdueCount = visible.filter((i) => i.severity === 'overdue').length;
  const urgentCount = visible.filter((i) => i.severity === 'urgent').length;

  return (
    <div className={'ins-alert' + (overdueCount > 0 ? ' ins-alert--has-overdue' : '')}>
      <div className="ins-alert__head">
        <div className="ins-alert__title">
          <span className="ins-alert__icon" aria-hidden>!</span>
          <span>4대보험 신고 마감 알림</span>
          <span className="ins-alert__count">
            {overdueCount > 0 && (
              <span className="ins-alert__count-pill ins-alert__count-pill--overdue">
                지연 {overdueCount}건
              </span>
            )}
            {urgentCount > 0 && (
              <span className="ins-alert__count-pill ins-alert__count-pill--urgent">
                임박 {urgentCount}건
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          className="ins-alert__more"
          onClick={() => navigate('/insurance')}
        >
          전체 보기 →
        </button>
      </div>
      <ul className="ins-alert__list">
        {visible.map((item) => (
          <li
            key={item.id}
            className={'ins-alert__item ins-alert__item--' + item.severity}
            onClick={() => item.routeTo && navigate(item.routeTo)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && item.routeTo) navigate(item.routeTo);
            }}
          >
            <span className={'ins-alert__dday ins-alert__dday--' + item.severity}>
              {ddayLabel(item)}
            </span>
            <span className="ins-alert__kind">{kindLabel(item.kind)}</span>
            <span className="ins-alert__desc">{item.description}</span>
            <span className="ins-alert__due">{item.dueDate}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ddayLabel(item: DeadlineItem): string {
  if (item.daysLeft < 0) return `+${Math.abs(item.daysLeft)}일`;
  if (item.daysLeft === 0) return 'D-day';
  return `D-${item.daysLeft}`;
}

function kindLabel(k: DeadlineItem['kind']): string {
  switch (k) {
    case 'ESTABLISH': return '보험관계 성립';
    case 'ACQUIRE': return '자격취득';
    case 'MONTHLY_REPORT': return '근로내용확인';
    case 'ANNUAL_TOTAL_PAY': return '보수총액 신고';
  }
}
