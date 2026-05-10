import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MacDatePicker } from '../components/MacDatePicker';
import { Modal } from '../components/Modal';
import {
  buildLedgerFromWage,
  downloadLedgerXlsx,
  appendToArchive,
} from '../utils/wageLedger';
import { siteApi } from '../api/site';
import { wageApi } from '../api/wage';
import type { Site } from '../api/site.types';
import type { WageMonthSummary } from '../api/wage.types';
import { useAuth } from '../hooks/useAuth';
import { flashCompletion } from '../utils/completionToast';
import './WagePayPage.css';

/**
 * 노무비 지급 — 지급·신고관리 그룹
 *
 *  데이터 흐름:
 *    출역·노무마감 (인증 → 일일 → 월공수 → 노무비 마감)
 *      └→ [노무비 지급] ← 지금 페이지
 *           ├→ 지급대기  (마감완료지만 미지급)
 *           ├→ 지급완료  (계좌이체·카카오톡 발송 완료)
 *           ├→ 지급보류  (관리자 보류 처리)
 *           └→ 계좌오류  (계좌 미등록·오류)
 *
 *  핵심 질문: "확정된 노무비를 누구에게 어떻게 지급했는가?"
 */

type PayStatus = 'PENDING' | 'PAID' | 'HOLD' | 'BANK_ERROR';

interface PayRow {
  siteId: string;
  siteName: string;
  totalNet: number;       // 실지급액 (마감된 금액)
  memberCount: number;    // 대상 인원
  monthClosed: boolean;   // 노무비 마감 여부
  status: PayStatus;
}

export function WagePayPage() {
  const { viewMode, assignedSiteId, user } = useAuth();
  const [sites, setSites] = useState<Site[]>([]);
  const [yearMonth, setYearMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [wageBySite, setWageBySite] = useState<Record<string, WageMonthSummary>>({});
  const [statusBySite, setStatusBySite] = useState<Record<string, PayStatus>>(() => {
    try {
      const raw = localStorage.getItem('bodapass.wagepay.status');
      if (raw) return JSON.parse(raw);
    } catch { /* */ }
    return {};
  });
  const [loading, setLoading] = useState(false);
  // 노무비 상세 팝업 — 클릭한 현장의 노무비 세부 내역 표시
  const [detailSiteId, setDetailSiteId] = useState<string | null>(null);

  function setStatus(siteId: string, status: PayStatus) {
    setStatusBySite((prev) => {
      const next = { ...prev, [siteId]: status };
      try { localStorage.setItem('bodapass.wagepay.status', JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  }

  /** 노무비대장 출력 — 표시 중인 모든 현장의 노임대장 XLSX 다운로드
   *  · 각 현장별로 별도 파일 생성 (현장명 + 연월 파일명)
   *  · 데이터 없는 현장은 건너뜀
   */
  async function handleLedgerExport() {
    const targets = sites.filter((s) => {
      const w = wageBySite[s.id];
      return w && w.rows && w.rows.length > 0;
    });
    if (targets.length === 0) {
      window.alert('출력할 노무비 데이터가 없습니다.');
      return;
    }
    const companyName = user?.companyName ?? '회사';
    const managerName = user?.name;
    let okCount = 0;
    for (const s of targets) {
      const summary = wageBySite[s.id];
      try {
        const doc = buildLedgerFromWage({ summary, site: s, companyName, managerName });
        appendToArchive(doc);
        await downloadLedgerXlsx(doc);
        okCount += 1;
        // 브라우저가 다중 다운로드를 차단하지 않도록 약간 간격
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        // 한 현장 실패해도 나머지 진행
        console.error('ledger xlsx fail:', s.name, err);
      }
    }
    if (okCount === 0) {
      window.alert('노무비대장 생성 실패. 다시 시도해주세요.');
    } else if (okCount < targets.length) {
      window.alert(`${okCount}/${targets.length} 현장의 노무비대장이 다운로드되었습니다. 일부 실패가 있습니다.`);
    }
  }

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

  const rows: PayRow[] = useMemo(() => {
    return sites
      .filter((s) => s.status !== 'COMPLETED')
      .map((s) => {
        const w = wageBySite[s.id];
        return {
          siteId: s.id,
          siteName: s.name,
          totalNet: w?.totalNet ?? 0,
          memberCount: w?.rows?.length ?? 0,
          monthClosed: !!w && w.totalNet > 0,
          status: statusBySite[s.id] ?? 'PENDING',
        };
      });
  }, [sites, wageBySite, statusBySite]);

  const kpi = useMemo(() => {
    const pending = rows.filter((r) => r.status === 'PENDING' && r.monthClosed).length;
    const paid = rows.filter((r) => r.status === 'PAID').length;
    const hold = rows.filter((r) => r.status === 'HOLD').length;
    const bankErr = rows.filter((r) => r.status === 'BANK_ERROR').length;
    const totalAmount = rows.reduce((s, r) => s + r.totalNet, 0);
    const paidAmount = rows.filter((r) => r.status === 'PAID').reduce((s, r) => s + r.totalNet, 0);
    return { pending, paid, hold, bankErr, totalAmount, paidAmount };
  }, [rows]);

  function k(n: number): string {
    if (!n) return '0';
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '억';
    if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
    return n.toLocaleString();
  }

  return (
    <div className="wp-page">
      <PageHeader
        title="노무비 지급"
        subtitle="확정된 실지급액을 지급대기 / 완료 / 보류 / 계좌오류로 관리합니다. 카카오톡·SMS·계좌이체 발송 후 상태를 갱신합니다."
      />

      {/* KPI 히어로 — 최상단 (PageHeader 바로 아래) */}
      <section className="wp-kpi">
        <KpiCard label="지급 대기" value={`${kpi.pending}곳`} tone="amber" />
        <KpiCard label="지급 완료" value={`${kpi.paid}곳`} tone="ok" />
        <KpiCard label="지급 보류" value={`${kpi.hold}곳`} tone="gray" />
        <KpiCard label="계좌 오류" value={`${kpi.bankErr}곳`} tone={kpi.bankErr > 0 ? 'danger' : undefined} />
        <KpiCard label="총 실지급" value={k(kpi.totalAmount)} unit="원" />
        <KpiCard label="지급 완료액" value={k(kpi.paidAmount)} unit="원" tone="ok" />
      </section>

      {/* 필터 — 히어로 아래, 외곽 타일 없이 flat 표시. 우측 끝에 노무비대장 출력 */}
      <section className="wp-filter wp-filter--flat">
        <div className="wp-filter__cell">
          <label>해당월</label>
          <MacDatePicker
            value={yearMonth}
            onChange={(v) => setYearMonth(v)}
            type="month"
          />
        </div>
        <div className="wp-filter__spacer" />
        <button
          type="button"
          className="wp-btn wp-btn--ghost"
          onClick={handleLedgerExport}
          disabled={loading || rows.length === 0}
          title="표시 중인 현장 전체의 노무비대장(.xlsx) 양식 다운로드"
        >
          노무비대장 출력
        </button>
      </section>

      {loading ? (
        <p className="wp-loading">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <div className="wp-empty">시공중인 현장이 없습니다.</div>
      ) : (
        <div className="wp-table-wrap">
          <table className="wp-table">
            <thead>
              <tr>
                <th className="wp-th-name">현장</th>
                <th>대상 인원</th>
                <th>실지급액</th>
                <th>마감</th>
                <th>지급 상태</th>
                <th>조치</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.siteId}>
                  <td className="wp-td-name"><strong>{r.siteName}</strong></td>
                  <td className="wp-td-num">{r.memberCount}명</td>
                  <td className="wp-td-num"><strong>{k(r.totalNet)}원</strong></td>
                  <td className="wp-td-center">
                    {r.monthClosed
                      ? <span className="wp-chip wp-chip--ok">마감</span>
                      : <span className="wp-chip wp-chip--gray">대기</span>}
                  </td>
                  <td className="wp-td-center">
                    <PayStatusChip status={r.status} />
                  </td>
                  <td className="wp-td-actions">
                    {r.monthClosed && r.status !== 'PAID' && (
                      <button type="button" className="wp-btn wp-btn--ok wp-btn--sm"
                        onClick={() => {
                          if (window.confirm(`「${r.siteName}」 ${k(r.totalNet)}원 지급 완료 처리?\n\n· 카카오톡·SMS 발송 + 계좌이체 후 「지급완료」 로 이동합니다.`)) {
                            setStatus(r.siteId, 'PAID');
                            flashCompletion(`${r.siteName} 지급 완료`);
                          }
                        }}
                      >지급완료</button>
                    )}
                    {r.status !== 'HOLD' && r.monthClosed && (
                      <button type="button" className="wp-btn wp-btn--sm"
                        onClick={() => setStatus(r.siteId, 'HOLD')}
                        title="지급을 보류 처리합니다 (HOLD)"
                      >지급완료(보류)</button>
                    )}
                    {r.status !== 'PENDING' && (
                      <button type="button" className="wp-btn wp-btn--sm"
                        onClick={() => setStatus(r.siteId, 'PENDING')}
                        title="대기 상태로 되돌립니다"
                      >대기</button>
                    )}
                    <button type="button" className="wp-btn wp-btn--sm"
                      onClick={() => setDetailSiteId(r.siteId)}
                      title="이 현장의 노무비 세부 내역 보기"
                    >상세</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 노무비 상세 팝업 — 선택 현장의 노무비 세부 내역 (근로자별 지급/공제 breakdown) */}
      {detailSiteId && (() => {
        const site = sites.find((s) => s.id === detailSiteId);
        const wage = wageBySite[detailSiteId];
        const memberRows = wage?.rows ?? [];
        const totGross = memberRows.reduce((s, x) => s + (x.baseAmount || 0), 0);
        const totDed = memberRows.reduce(
          (s, x) =>
            s +
            (x.deductionPension || 0) +
            (x.deductionHealth || 0) +
            (x.deductionEmployment || 0) +
            (x.deductionAccident || 0) +
            (x.deductionIncomeTax || 0) +
            (x.deductionLocalTax || 0),
          0,
        );
        const totNet = memberRows.reduce((s, x) => s + (x.netAmount || 0), 0);
        return (
          <Modal
            open
            onClose={() => setDetailSiteId(null)}
            title="노무비 상세"
            subtitle={
              <>
                <div>{site?.name ?? '현장'}</div>
                <div style={{ marginTop: 2 }}>{yearMonth} · 근로자 {memberRows.length}명</div>
              </>
            }
            width={920}
            footer={
              <button
                type="button"
                className="wp-btn wp-btn--ghost"
                onClick={() => setDetailSiteId(null)}
              >
                닫기
              </button>
            }
          >
            <div className="wp-detail">
              {memberRows.length === 0 ? (
                <p className="wp-detail__empty">이번 달 출역 기록이 없습니다.</p>
              ) : (
                <>
                  {/* 합계 요약 — 4타일 (대상 인원 / 총 지급액 / 공제 합계 / 실지급액) */}
                  <div className="wp-detail__summary">
                    <div className="wp-detail__summary-row">
                      <span>대상 인원</span>
                      <strong>{memberRows.length}명</strong>
                    </div>
                    <div className="wp-detail__summary-row">
                      <span>총 지급액</span>
                      <strong>{totGross.toLocaleString()}원</strong>
                    </div>
                    <div className="wp-detail__summary-row wp-detail__summary-row--ded">
                      <span>공제 합계</span>
                      <strong>{totDed.toLocaleString()}원</strong>
                    </div>
                    <div className="wp-detail__summary-row wp-detail__summary-row--total">
                      <span>실지급액</span>
                      <strong>{totNet.toLocaleString()}원</strong>
                    </div>
                  </div>

                  {/* 근로자별 세부 표 */}
                  <div className="wp-detail__table-wrap">
                    <table className="wp-detail__table">
                      <thead>
                        <tr>
                          <th className="wp-detail__th-no">#</th>
                          <th>성명</th>
                          <th>직종</th>
                          <th className="wp-detail__num">근로일</th>
                          <th className="wp-detail__num">일당</th>
                          <th className="wp-detail__num">지급금액</th>
                          <th className="wp-detail__num">공제 합계</th>
                          <th className="wp-detail__num">실지급액</th>
                        </tr>
                      </thead>
                      <tbody>
                        {memberRows.map((m, i) => {
                          const ded =
                            (m.deductionPension || 0) +
                            (m.deductionHealth || 0) +
                            (m.deductionEmployment || 0) +
                            (m.deductionAccident || 0) +
                            (m.deductionIncomeTax || 0) +
                            (m.deductionLocalTax || 0);
                          return (
                            <tr key={m.memberId}>
                              <td>{i + 1}</td>
                              <td><strong>{m.memberName}</strong></td>
                              <td>{m.role || '—'}</td>
                              <td className="wp-detail__num">{m.workDays}일</td>
                              <td className="wp-detail__num">{(m.dailyWage || 0).toLocaleString()}원</td>
                              <td className="wp-detail__num">{(m.baseAmount || 0).toLocaleString()}원</td>
                              <td className="wp-detail__num wp-detail__num--ded">{ded.toLocaleString()}원</td>
                              <td className="wp-detail__num"><strong>{(m.netAmount || 0).toLocaleString()}원</strong></td>
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
}: { label: string; value: React.ReactNode; unit?: string; tone?: 'ok' | 'amber' | 'danger' | 'gray' }) {
  const cls = 'wp-kpi__card' + (tone ? ' wp-kpi__card--' + tone : '');
  return (
    <div className={cls}>
      <div className="wp-kpi__label">{label}</div>
      <div className="wp-kpi__value">
        {value}
        {unit && <span className="wp-kpi__unit">{unit}</span>}
      </div>
    </div>
  );
}

function PayStatusChip({ status }: { status: PayStatus }) {
  const map = {
    PENDING:    { label: '지급대기', tone: 'amber' },
    PAID:       { label: '지급완료', tone: 'green' },
    HOLD:       { label: '지급보류', tone: 'gray' },
    BANK_ERROR: { label: '계좌오류', tone: 'red' },
  } as const;
  const m = map[status];
  return <span className={'wp-status wp-status--' + m.tone}>{m.label}</span>;
}
