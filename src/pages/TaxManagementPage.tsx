import { useEffect, useMemo, useState } from 'react';
import { localYearMonth } from '../utils/dateLocal';
import { PageHeader } from '../components/PageHeader';
import { siteApi } from '../api/site';
import { wageApi } from '../api/wage';
import type { Site } from '../api/site.types';
import type { WageMonthSummary } from '../api/wage.types';
import { useAuth } from '../hooks/useAuth';
import './TaxManagementPage.css';

import { MacDatePicker } from '../components/MacDatePicker';
import { Modal } from '../components/Modal';
/**
 * 세금관리 — 지급·신고관리 그룹
 *
 *  소득세·지방소득세·원천징수 기초자료를 관리하는 화면.
 *  핵심 질문: "이번 달 원천징수해야 할 세금이 얼마인가?"
 *
 *  데이터 소스:
 *    노무비 마감(wageApi.monthSummary).rows[].deductionIncomeTax + deductionLocalTax
 *    → 현장별 / 근로자별 합계 + 원천징수 신고서 양식 출력 준비
 */

export function TaxManagementPage() {
  const { viewMode, assignedSiteId } = useAuth();
  const [sites, setSites] = useState<Site[]>([]);
  const [yearMonth, setYearMonth] = useState(() => localYearMonth());
  const [wageBySite, setWageBySite] = useState<Record<string, WageMonthSummary>>({});
  const [loading, setLoading] = useState(false);
  // 노무비 상세 팝업 — 클릭한 현장의 세금 상세 내역 표시
  const [detailSiteId, setDetailSiteId] = useState<string | null>(null);

  useEffect(() => {
    siteApi.listSites().then((s) => {
      const visible = viewMode === 'SITE' && assignedSiteId
        ? s.sites.filter((x) => x.id === assignedSiteId)
        : s.sites;
      setSites(visible);
    }).catch(() => { /* */ });
  }, [viewMode, assignedSiteId]);

  useEffect(() => {
    if (sites.length === 0) return;
    setLoading(true);
    Promise.all(
      sites.filter((s) => s.status !== 'COMPLETED').map((s) =>
        wageApi.monthSummary({ siteId: s.id, yearMonth })
          .then((w) => ({ siteId: s.id, wage: w }))
          .catch(() => null),
      ),
    ).then((results) => {
      const map: Record<string, WageMonthSummary> = {};
      for (const r of results) if (r) map[r.siteId] = r.wage;
      setWageBySite(map);
    }).finally(() => setLoading(false));
  }, [sites, yearMonth]);

  const rows = useMemo(() => {
    return sites
      .filter((s) => s.status !== 'COMPLETED')
      .map((s) => {
        const w = wageBySite[s.id];
        const incomeTax = (w?.rows ?? []).reduce((sum, r) => sum + (r.deductionIncomeTax || 0), 0);
        const localTax  = (w?.rows ?? []).reduce((sum, r) => sum + (r.deductionLocalTax  || 0), 0);
        const memberCount = w?.rows?.length ?? 0;
        return {
          siteId: s.id, siteName: s.name,
          memberCount, incomeTax, localTax,
          totalTax: incomeTax + localTax,
        };
      });
  }, [sites, wageBySite]);

  const total = useMemo(() => {
    return {
      sites: rows.length,
      members: rows.reduce((s, r) => s + r.memberCount, 0),
      incomeTax: rows.reduce((s, r) => s + r.incomeTax, 0),
      localTax: rows.reduce((s, r) => s + r.localTax, 0),
      total: rows.reduce((s, r) => s + r.totalTax, 0),
    };
  }, [rows]);

  function k(n: number): string {
    if (!n) return '0';
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
    return n.toLocaleString();
  }

  return (
    <div className="tx-page">
      <PageHeader
        title="세금관리"
        subtitle="원천징수 대상 소득세·지방소득세 기초자료를 현장별로 관리합니다. 노무비 마감 데이터에서 자동 산출됩니다."
      />

      {/* KPI 히어로 — 최상단 (PageHeader 바로 아래) */}
      <section className="tx-kpi">
        <KpiCard label="대상 현장" value={`${total.sites}곳`} />
        <KpiCard label="대상 근로자" value={`${total.members}명`} />
        <KpiCard label="소득세 합계" value={k(total.incomeTax)} unit="원" tone="amber" />
        <KpiCard label="지방소득세 합계" value={k(total.localTax)} unit="원" tone="amber" />
        <KpiCard label="원천징수 총액" value={k(total.total)} unit="원" tone="ok" />
      </section>

      {/* 필터 — 히어로 아래, 외곽 타일 없이 flat 표시 */}
      <section className="tx-filter tx-filter--flat">
        <div className="tx-filter__cell">
          <label>해당월</label>
          <MacDatePicker
              value={yearMonth}
              onChange={(v) => setYearMonth(v)}
              type="month"
            />
        </div>
      </section>

      {loading ? (
        <p className="tx-loading">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <div className="tx-empty">시공중인 현장이 없습니다.</div>
      ) : (
        <div className="tx-table-wrap">
          <table className="tx-table">
            <thead>
              <tr>
                <th className="tx-th-name">현장</th>
                <th>대상 인원</th>
                <th>소득세</th>
                <th>지방소득세</th>
                <th>합계</th>
                <th>조치</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.siteId}>
                  <td className="tx-td-name"><strong>{r.siteName}</strong></td>
                  <td className="tx-td-num">{r.memberCount}명</td>
                  <td className="tx-td-num">{k(r.incomeTax)}원</td>
                  <td className="tx-td-num">{k(r.localTax)}원</td>
                  <td className="tx-td-num"><strong>{k(r.totalTax)}원</strong></td>
                  <td className="tx-td-actions">
                    <button type="button" className="tx-btn tx-btn--sm"
                      onClick={() => setDetailSiteId(r.siteId)}
                      title="이 현장의 노무비 세금 세부 내역 보기"
                    >
                      노무비 상세
                    </button>
                    <button type="button" className="tx-btn tx-btn--sm"
                      onClick={() => window.alert('준비중입니다.')}
                      title="신고서 출력 (준비중)"
                    >
                      신고서 출력
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tx-note">
        <strong>참고:</strong> 일용근로자는 일당 187,000원(2026년 기준) 이하 시 소득세 면제. 본 화면은 노무비 마감의
        <code> deductionIncomeTax / deductionLocalTax </code> 합계를 표시하며, 신고서 양식은 출력센터에서 발행합니다.
      </div>

      {/* 노무비 상세 팝업 — 선택 현장의 세금 세부 내역 (근로자별 소득세/지방세 breakdown) */}
      {detailSiteId && (() => {
        const site = sites.find((s) => s.id === detailSiteId);
        const wage = wageBySite[detailSiteId];
        const memberRows = wage?.rows ?? [];
        const totIncome = memberRows.reduce((s, x) => s + (x.deductionIncomeTax || 0), 0);
        const totLocal = memberRows.reduce((s, x) => s + (x.deductionLocalTax || 0), 0);
        const totPay = memberRows.reduce((s, x) => s + (x.baseAmount || 0), 0);
        return (
          <Modal
            open
            onClose={() => setDetailSiteId(null)}
            title="노무비 상세 — 세금 세부 내역"
            subtitle={
              <>
                <div>{site?.name ?? '현장'}</div>
                <div style={{ marginTop: 2 }}>{yearMonth} · 근로자 {memberRows.length}명</div>
              </>
            }
            width={760}
            footer={
              <button
                type="button"
                className="tx-btn tx-btn--ghost"
                onClick={() => setDetailSiteId(null)}
              >
                닫기
              </button>
            }
          >
            <div className="tx-detail">
              {memberRows.length === 0 ? (
                <p className="tx-detail__empty">이번 달 출역 기록이 없습니다.</p>
              ) : (
                <>
                  {/* 합계 요약 */}
                  <div className="tx-detail__summary">
                    <div className="tx-detail__summary-row">
                      <span>대상 인원</span>
                      <strong>{memberRows.length}명</strong>
                    </div>
                    <div className="tx-detail__summary-row">
                      <span>지급금액 합계</span>
                      <strong>{k(totPay)}원</strong>
                    </div>
                    <div className="tx-detail__summary-row">
                      <span>소득세 합계</span>
                      <strong>{k(totIncome)}원</strong>
                    </div>
                    <div className="tx-detail__summary-row">
                      <span>지방소득세 합계</span>
                      <strong>{k(totLocal)}원</strong>
                    </div>
                    <div className="tx-detail__summary-row tx-detail__summary-row--total">
                      <span>원천징수 합계</span>
                      <strong>{k(totIncome + totLocal)}원</strong>
                    </div>
                  </div>

                  {/* 근로자별 세부 표 */}
                  <div className="tx-detail__table-wrap">
                    <table className="tx-detail__table">
                      <thead>
                        <tr>
                          <th className="tx-detail__th-no">#</th>
                          <th>성명</th>
                          <th>직종</th>
                          <th className="tx-detail__num">근로일</th>
                          <th className="tx-detail__num">지급금액</th>
                          <th className="tx-detail__num">소득세</th>
                          <th className="tx-detail__num">지방소득세</th>
                          <th className="tx-detail__num">합계</th>
                        </tr>
                      </thead>
                      <tbody>
                        {memberRows.map((m, i) => {
                          const inc = m.deductionIncomeTax || 0;
                          const loc = m.deductionLocalTax || 0;
                          return (
                            <tr key={m.memberId}>
                              <td>{i + 1}</td>
                              <td><strong>{m.memberName}</strong></td>
                              <td>{m.role || '—'}</td>
                              <td className="tx-detail__num">{m.workDays}일</td>
                              <td className="tx-detail__num">{(m.baseAmount || 0).toLocaleString()}원</td>
                              <td className="tx-detail__num">{inc.toLocaleString()}원</td>
                              <td className="tx-detail__num">{loc.toLocaleString()}원</td>
                              <td className="tx-detail__num"><strong>{(inc + loc).toLocaleString()}원</strong></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

function KpiCard({
  label, value, unit, tone,
}: { label: string; value: React.ReactNode; unit?: string; tone?: 'ok' | 'amber' }) {
  const cls = 'tx-kpi__card' + (tone ? ' tx-kpi__card--' + tone : '');
  return (
    <div className={cls}>
      <div className="tx-kpi__label">{label}</div>
      <div className="tx-kpi__value">
        {value}
        {unit && <span className="tx-kpi__unit">{unit}</span>}
      </div>
    </div>
  );
}
