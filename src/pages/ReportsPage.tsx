import { useCallback, useEffect, useMemo, useState } from 'react';
import { localYearMonth } from '../utils/dateLocal';
import { PageHeader } from '../components/PageHeader';
import { siteApi } from '../api/site';
import { teamApi } from '../api/team';
import { wageApi } from '../api/wage';
import { attendanceApi } from '../api/attendance';
import { apiClient } from '../api/client';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import type { Company, Foreman, Site, SiteCompany } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import type { WageMonthSummary } from '../api/wage.types';
import './ReportsPage.css';

import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
/**
 * 통계 / 리포트 (HQ 전용)
 *  - 본사 사용자가 자기 회사 + owner 인 site 들을 한 화면에서 비교/분석
 *  - 현재 월 기준 (헤더에서 월 변경 가능)
 */

type SiteWageItem = { site: Site; wage: WageMonthSummary; monthClosed: boolean };

export function ReportsPage() {
  const { user } = useAuth();
  const [yearMonth, setYearMonth] = useState(() => localYearMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [siteCompanies, setSiteCompanies] = useState<SiteCompany[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [foremen, setForemen] = useState<Foreman[]>([]);
  const [perSite, setPerSite] = useState<SiteWageItem[]>([]);
  /** 트렌드 — 선택된 site 의 최근 6개월 [yearMonth, wage, attendees] */
  const [trendSiteId, setTrendSiteId] = useState<string>('');
  const [trend, setTrend] = useState<Array<{
    yearMonth: string;
    workDays: number;
    attendees: number;
    labor: number;
    insurance: number;
    retireFund: number;
  }>>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, m, f, cRes, scRes] = await Promise.all([
        siteApi.listSites(),
        teamApi.list({ status: 'ALL' }),
        siteApi.listForemen(),
        apiClient.get<{ companies: Company[] }>('/companies'),
        apiClient.get<{ siteCompanies: SiteCompany[] }>('/site-companies'),
      ]);
      setSites(s.sites);
      setMembers(m.members);
      setForemen(f.foremen);
      setCompanies(cRes.data.companies ?? []);
      setSiteCompanies(scRes.data.siteCompanies ?? []);
      // 현장별 wage + monthClose 병렬 로드
      const wageList = await Promise.all(
        s.sites.map((site) =>
          Promise.all([
            wageApi.monthSummary({ siteId: site.id, yearMonth }),
            attendanceApi.closeStatus(site.id, yearMonth).catch(() => null),
          ]).then(([w, c]) => ({ site, wage: w, monthClosed: c?.monthClose?.status === 'CLOSED' })),
        ),
      );
      setPerSite(wageList);
    } catch (err) {
      setError(getErrorMessage(err, '리포트 로딩 실패'));
    } finally {
      setLoading(false);
    }
  }, [yearMonth]);

  useEffect(() => { load(); }, [load]);

  // 처음 사이트가 로드되면 트렌드 기본 site = 첫 번째
  useEffect(() => {
    if (sites.length > 0 && !trendSiteId) {
      setTrendSiteId(sites[0].id);
    }
  }, [sites, trendSiteId]);

  // trendSiteId 또는 yearMonth 가 바뀌면 최근 6개월 fetch
  useEffect(() => {
    if (!trendSiteId) return;
    let cancelled = false;
    (async () => {
      setTrendLoading(true);
      try {
        // yearMonth 기준 직전 6개월 (포함)
        const months: string[] = [];
        const [yStr, mStr] = yearMonth.split('-');
        let y = Number(yStr), m = Number(mStr);
        for (let i = 0; i < 6; i++) {
          months.unshift(`${y}-${String(m).padStart(2, '0')}`);
          m -= 1;
          if (m < 1) { m = 12; y -= 1; }
        }
        const results = await Promise.all(
          months.map((ym) =>
            wageApi.monthSummary({ siteId: trendSiteId, yearMonth: ym }).catch(() => null),
          ),
        );
        if (cancelled) return;
        const next = months.map((ym, i) => {
          const w = results[i];
          if (!w) return { yearMonth: ym, workDays: 0, attendees: 0, labor: 0, insurance: 0, retireFund: 0 };
          const labor = w.rows.reduce((s, r) => s + r.netAmount, 0);
          const workDays = w.rows.reduce((s, r) => s + r.workDays, 0);
          const attendees = w.rows.filter((r) => r.workDays > 0).length;
          const insurance = Math.round(labor * (0.045 + 0.03545 + 0.009 + 0.0093));
          const retireFund = Math.round(labor * 0.005);
          return { yearMonth: ym, workDays, attendees, labor, insurance, retireFund };
        });
        setTrend(next);
      } finally {
        if (!cancelled) setTrendLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [trendSiteId, yearMonth]);

  // ───── 집계 ─────
  const totals = useMemo(() => {
    let labor = 0, pension = 0, health = 0, employ = 0, accident = 0, retire = 0;
    let workDays = 0, contractAmt = 0;
    let closedCount = 0;
    for (const p of perSite) {
      const monthly = p.wage.rows.reduce((sum, r) => sum + r.netAmount, 0);
      labor += monthly;
      pension += Math.round(monthly * 0.045);
      health += Math.round(monthly * 0.03545);
      employ += Math.round(monthly * 0.009);
      accident += Math.round(monthly * 0.0093);
      retire += Math.round(monthly * 0.005);
      workDays += p.wage.rows.reduce((sum, r) => sum + r.workDays, 0);
      contractAmt += p.site.contractAmount;
      if (p.monthClosed) closedCount += 1;
    }
    return { labor, pension, health, employ, accident, retire, workDays, contractAmt, closedCount };
  }, [perSite]);

  // 직종별 인건비 (이번 달)
  const roleBreakdown = useMemo(() => {
    const map = new Map<string, { role: string; net: number; days: number; count: number }>();
    for (const p of perSite) {
      for (const r of p.wage.rows) {
        const cur = map.get(r.role) ?? { role: r.role, net: 0, days: 0, count: 0 };
        cur.net += r.netAmount; cur.days += r.workDays; cur.count += 1;
        map.set(r.role, cur);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.net - a.net).slice(0, 10);
  }, [perSite]);

  // 진행 상태 카운트
  const progress = useMemo(() => {
    const totalMembers = members.length;
    const contracted = members.filter((m) => m.contractSigned).length;
    const faceVerified = members.filter((m) => m.faceVerified).length;
    const eduDone = members.filter((m) => m.safetyEduCompleted).length;
    const totalForemen = foremen.length;
    const registered = foremen.filter((f) => f.registered).length;
    return {
      contractRate: totalMembers ? Math.round((contracted / totalMembers) * 100) : 0,
      faceRate: totalMembers ? Math.round((faceVerified / totalMembers) * 100) : 0,
      eduRate: totalMembers ? Math.round((eduDone / totalMembers) * 100) : 0,
      foremanRate: totalForemen ? Math.round((registered / totalForemen) * 100) : 0,
      totalMembers, contracted, faceVerified, eduDone,
      totalForemen, registered,
    };
  }, [members, foremen]);

  return (
    <div className="rep">
      <PageHeader
        title="통계 / 리포트"
        subtitle={`${yearMonth} · 본사 종합 지표`}
        actions={
          <div className="rep__head-actions">
            <MacDatePicker
              value={yearMonth}
              onChange={(v) => setYearMonth(v)}
              type="month"
              className="rep__month"
            />
            <button type="button" className="rep__refresh" onClick={load} disabled={loading}>
              {loading ? '불러오는 중…' : '↻ 새로고침'}
            </button>
          </div>
        }
      />

      {error && <div className="rep__error">{error}</div>}

      {/* ① KPI 4 카드 */}
      <section className="rep__kpis">
        <KpiCard
          label="활성 현장"
          value={`${perSite.filter((p) => p.site.status === 'IN_PROGRESS').length}개`}
          sub={`총 ${perSite.length}개 · 도급 ${krwShort(totals.contractAmt)}`}
          accent="primary"
        />
        <KpiCard
          label="이번 달 인건비"
          value={krw(totals.labor)}
          sub={`${totals.workDays}일 · ${members.length}명`}
          accent="emerald"
        />
        <KpiCard
          label="4대보험·퇴직공제 합계"
          value={krw(totals.pension + totals.health + totals.employ + totals.accident + totals.retire)}
          sub={`연금 ${krwShort(totals.pension)} · 건강 ${krwShort(totals.health)} · 산재 ${krwShort(totals.accident)}`}
          accent="amber"
        />
        <KpiCard
          label="월마감 진척"
          value={`${totals.closedCount}/${perSite.length}`}
          sub={
            totals.closedCount === perSite.length
              ? '✓ 모든 현장 마감 완료'
              : `미마감 ${perSite.length - totals.closedCount}개 — 임금 발행 보류`
          }
          accent={totals.closedCount === perSite.length ? 'emerald' : 'rose'}
        />
      </section>

      {/* ② 현장별 인건비 비중 + 공정률 */}
      <div className="rep__row rep__row--2">
        <section className="rep__card">
          <header className="rep__card-head">
            <h3>현장별 인건비 비중 (이번 달)</h3>
            <span className="rep__card-sub">실 지급액 기준 · 상위 8개</span>
          </header>
          <SiteShareChart
            items={perSite
              .map((p) => ({
                id: p.site.id,
                name: p.site.name,
                value: p.wage.rows.reduce((s, r) => s + r.netAmount, 0),
              }))
              .filter((x) => x.value > 0)
              .sort((a, b) => b.value - a.value)
              .slice(0, 8)}
          />
        </section>
        <section className="rep__card">
          <header className="rep__card-head">
            <h3>현장별 공정률</h3>
            <span className="rep__card-sub">전체 도급 대비 진척</span>
          </header>
          <ProgressList
            items={[...perSite]
              .sort((a, b) => b.site.progressPercent - a.site.progressPercent)
              .map((p) => ({
                id: p.site.id,
                name: p.site.name,
                value: p.site.progressPercent,
                budget: krwShort(p.site.contractAmount),
                closed: p.monthClosed,
              }))}
          />
        </section>
      </div>

      {/* ③ 직종별 인건비 + 4대보험 항목별 */}
      <div className="rep__row rep__row--2">
        <section className="rep__card">
          <header className="rep__card-head">
            <h3>직종별 인건비 (이번 달)</h3>
            <span className="rep__card-sub">실 지급액 · 상위 10개 직종</span>
          </header>
          <RoleBars items={roleBreakdown} />
        </section>
        <section className="rep__card">
          <header className="rep__card-head">
            <h3>월별 납부 — 4대보험 + 퇴직공제부금</h3>
            <span className="rep__card-sub">사용자 부담분 합산</span>
          </header>
          <InsuranceBars
            items={[
              { label: '국민연금', value: totals.pension, color: '#0ea5e9' },
              { label: '건강보험', value: totals.health, color: '#14b8a6' },
              { label: '고용보험', value: totals.employ, color: '#f59e0b' },
              { label: '산재보험', value: totals.accident, color: '#ef4444' },
              { label: '퇴직공제부금', value: totals.retire, color: '#8b5cf6' },
            ]}
          />
        </section>
      </div>

      {/* ④ 진행 진척 도넛 4개 */}
      <section className="rep__card">
        <header className="rep__card-head">
          <h3>운영 진척도</h3>
          <span className="rep__card-sub">근로계약·얼굴인증·안전교육·반장가입</span>
        </header>
        <div className="rep__donuts">
          <Donut label="근로계약 체결" value={progress.contractRate} sub={`${progress.contracted}/${progress.totalMembers}명`} color="#007AFF" />
          <Donut label="얼굴인증 완료" value={progress.faceRate} sub={`${progress.faceVerified}/${progress.totalMembers}명`} color="#0ea5e9" />
          <Donut label="안전교육 이수" value={progress.eduRate} sub={`${progress.eduDone}/${progress.totalMembers}명`} color="#f59e0b" />
          <Donut label="반장 앱가입" value={progress.foremanRate} sub={`${progress.registered}/${progress.totalForemen}명`} color="#8b5cf6" />
        </div>
      </section>

      {/* ⑤ 현장별 월별 트렌드 — 출력인원 / 인건비 / 사회보험 */}
      <section className="rep__card">
        <header className="rep__card-head">
          <h3>현장별 월별 트렌드</h3>
          <span className="rep__card-sub">선택한 현장의 최근 6개월 출력인원·인건비·사회보험 추이</span>
        </header>
        <div className="rep__trend-toolbar">
          <label className="rep__trend-label">현장</label>
          <MacSelect
              value={trendSiteId}
              onChange={(v) => setTrendSiteId(v)}
              className="rep__trend-select"
              options={[...sites.map((s) => (
              ({ value: s.id, label: s.name })
            ))]}
            />
          {trendLoading && <span className="rep__trend-loading">불러오는 중…</span>}
        </div>
        <TrendBars
          rows={trend}
          metric="attendees"
          label="출력 인원 (월별)"
          unit="명"
          color="#0ea5e9"
        />
        <TrendBars
          rows={trend}
          metric="labor"
          label="인건비 (월별 실 지급액)"
          unit="원"
          color="#007AFF"
          short
        />
        <TrendBars
          rows={trend}
          metric="insurance"
          label="4대보험 (월별 사용자 부담분 합산)"
          unit="원"
          color="#f59e0b"
          short
        />
        <TrendBars
          rows={trend}
          metric="retireFund"
          label="퇴직공제부금 (월별)"
          unit="원"
          color="#8b5cf6"
          short
        />
        {/* 상세 표 */}
        <div className="rep__trend-table-wrap">
          <table className="rep__trend-table">
            <thead>
              <tr>
                <th>월</th>
                <th className="rep__trend-num">출력 인원</th>
                <th className="rep__trend-num">근무일 합계</th>
                <th className="rep__trend-num">인건비</th>
                <th className="rep__trend-num">4대보험</th>
                <th className="rep__trend-num">퇴직공제부금</th>
              </tr>
            </thead>
            <tbody>
              {trend.map((r) => (
                <tr key={r.yearMonth}>
                  <td>{r.yearMonth}</td>
                  <td className="rep__trend-num">{r.attendees}명</td>
                  <td className="rep__trend-num">{r.workDays}일</td>
                  <td className="rep__trend-num"><strong>{krw(r.labor)}</strong></td>
                  <td className="rep__trend-num">{krw(r.insurance)}</td>
                  <td className="rep__trend-num">{krw(r.retireFund)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>6개월 합계</td>
                <td className="rep__trend-num">평균 {Math.round(trend.reduce((s, r) => s + r.attendees, 0) / Math.max(1, trend.length))}명</td>
                <td className="rep__trend-num">{trend.reduce((s, r) => s + r.workDays, 0)}일</td>
                <td className="rep__trend-num"><strong>{krw(trend.reduce((s, r) => s + r.labor, 0))}</strong></td>
                <td className="rep__trend-num">{krw(trend.reduce((s, r) => s + r.insurance, 0))}</td>
                <td className="rep__trend-num">{krw(trend.reduce((s, r) => s + r.retireFund, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ⑥ 회사별 작업자 수 (cross-company 시연 — 인천 동현 등) */}
      {companies.length > 1 && (
        <section className="rep__card">
          <header className="rep__card-head">
            <h3>참여 회사별 인원</h3>
            <span className="rep__card-sub">현장에 합류된 회사들의 작업자 수</span>
          </header>
          <CompanyMembers
            siteCompanies={siteCompanies}
            companies={companies}
            members={members}
            sites={sites}
            myCompanyId={user?.companyId ?? ''}
          />
        </section>
      )}
    </div>
  );
}

/* ───────── 작은 컴포넌트들 ───────── */

function KpiCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string;
  accent: 'primary' | 'emerald' | 'amber' | 'rose';
}) {
  return (
    <div className={'rep__kpi rep__kpi--' + accent}>
      <span className="rep__kpi-label">{label}</span>
      <span className="rep__kpi-value">{value}</span>
      {sub && <span className="rep__kpi-sub">{sub}</span>}
    </div>
  );
}

function SiteShareChart({ items }: { items: Array<{ id: string; name: string; value: number }> }) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <p className="rep__empty">데이터 없음</p>;
  const palette = ['#6366f1', '#0ea5e9', '#007AFF', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316'];
  return (
    <div className="rep__share">
      {/* 막대 그라데이션 */}
      <div className="rep__share-bar">
        {items.map((it, i) => {
          const pct = (it.value / total) * 100;
          return (
            <span
              key={it.id}
              className="rep__share-seg"
              style={{ width: pct + '%', background: palette[i % palette.length] }}
              title={`${it.name} — ${krw(it.value)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      {/* 범례 */}
      <ul className="rep__share-legend">
        {items.map((it, i) => {
          const pct = (it.value / total) * 100;
          return (
            <li key={it.id}>
              <span className="rep__legend-dot" style={{ background: palette[i % palette.length] }} />
              <span className="rep__legend-name">{it.name}</span>
              <span className="rep__legend-val">{krwShort(it.value)} · {pct.toFixed(1)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProgressList({ items }: {
  items: Array<{ id: string; name: string; value: number; budget: string; closed: boolean }>;
}) {
  if (items.length === 0) return <p className="rep__empty">데이터 없음</p>;
  return (
    <ul className="rep__progress">
      {items.map((it) => (
        <li key={it.id} className="rep__progress-row">
          <span className="rep__progress-name">{it.name}</span>
          <div className="rep__progress-bar">
            <span
              className={'rep__progress-fill ' + (it.value >= 80 ? 'is-high' : it.value >= 30 ? 'is-mid' : 'is-low')}
              style={{ width: it.value + '%' }}
            />
          </div>
          <span className="rep__progress-meta">
            <strong>{it.value}%</strong>
            <em>{it.budget}</em>
            {it.closed && <span className="rep__chip rep__chip--ok">🔒</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RoleBars({ items }: {
  items: Array<{ role: string; net: number; days: number; count: number }>;
}) {
  if (items.length === 0) return <p className="rep__empty">데이터 없음</p>;
  const max = Math.max(...items.map((x) => x.net), 1);
  return (
    <ul className="rep__rolebars">
      {items.map((it) => (
        <li key={it.role}>
          <span className="rep__rolebars-name">{it.role}</span>
          <div className="rep__rolebars-bar">
            <span className="rep__rolebars-fill" style={{ width: ((it.net / max) * 100) + '%' }} />
          </div>
          <span className="rep__rolebars-val">
            <strong>{krw(it.net)}</strong>
            <em>{it.count}명 · {it.days}일</em>
          </span>
        </li>
      ))}
    </ul>
  );
}

function InsuranceBars({ items }: {
  items: Array<{ label: string; value: number; color: string }>;
}) {
  const max = Math.max(...items.map((x) => x.value), 1);
  return (
    <ul className="rep__insbars">
      {items.map((it) => (
        <li key={it.label}>
          <span className="rep__insbars-name" style={{ color: it.color }}>{it.label}</span>
          <div className="rep__insbars-bar">
            <span
              className="rep__insbars-fill"
              style={{ width: ((it.value / max) * 100) + '%', background: it.color }}
            />
          </div>
          <span className="rep__insbars-val">{krw(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Donut({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const off = c - (Math.min(100, Math.max(0, value)) / 100) * c;
  return (
    <div className="rep__donut">
      <svg viewBox="0 0 80 80" className="rep__donut-svg">
        <circle cx="40" cy="40" r={r} stroke="#e5e7eb" strokeWidth="9" fill="none" />
        <circle
          cx="40" cy="40" r={r}
          stroke={color}
          strokeWidth="9"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          transform="rotate(-90 40 40)"
          style={{ transition: 'stroke-dashoffset 0.45s ease' }}
        />
        <text x="40" y="44" textAnchor="middle" fontSize="14" fontWeight="800" fill={color}>
          {value}%
        </text>
      </svg>
      <span className="rep__donut-label">{label}</span>
      <span className="rep__donut-sub">{sub}</span>
    </div>
  );
}

function CompanyMembers({
  siteCompanies, companies, members, sites, myCompanyId,
}: {
  siteCompanies: SiteCompany[]; companies: Company[]; members: TeamMember[]; sites: Site[]; myCompanyId: string;
}) {
  const companyById = new Map(companies.map((c) => [c.id, c] as const));
  const siteById = new Map(sites.map((s) => [s.id, s] as const));
  // (siteCompanyId) -> count
  const memberCount = new Map<string, number>();
  for (const m of members) {
    if (!m.siteCompanyId) continue;
    memberCount.set(m.siteCompanyId, (memberCount.get(m.siteCompanyId) ?? 0) + 1);
  }
  // Group by site
  const bySite = new Map<string, SiteCompany[]>();
  for (const sc of siteCompanies) {
    if (sc.status !== 'ACTIVE') continue;
    const arr = bySite.get(sc.siteId) ?? [];
    arr.push(sc);
    bySite.set(sc.siteId, arr);
  }
  const groups = Array.from(bySite.entries())
    .filter(([, arr]) => arr.length > 1) // 다회사 참여 site 만
    .map(([siteId, arr]) => ({ siteId, site: siteById.get(siteId), companies: arr }))
    .filter((g) => g.site);
  if (groups.length === 0) {
    return <p className="rep__empty">다회사 참여 현장이 없습니다.</p>;
  }
  return (
    <div className="rep__company-grid">
      {groups.map((g) => (
        <div key={g.siteId} className="rep__company-card">
          <h4 className="rep__company-title">{g.site!.name}</h4>
          <ul className="rep__company-list">
            {g.companies.map((sc) => {
              const isMine = sc.companyId === myCompanyId;
              const co = companyById.get(sc.companyId);
              const cnt = memberCount.get(sc.id) ?? 0;
              return (
                <li key={sc.id} className={isMine ? 'is-mine' : ''}>
                  <span className={'rep__company-role rep__company-role--' + (sc.role === '원도급' ? 'prime' : 'sub')}>
                    {sc.role}
                  </span>
                  <span className="rep__company-name">
                    {co?.name ?? sc.companyId}
                    {sc.specialty && <em> · {sc.specialty}</em>}
                  </span>
                  <span className="rep__company-cnt">{cnt}명</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ───────── 월별 트렌드 — 6개월 가로 막대 ───────── */
function TrendBars({
  rows,
  metric,
  label,
  unit,
  color,
  short,
}: {
  rows: Array<{
    yearMonth: string;
    workDays: number;
    attendees: number;
    labor: number;
    insurance: number;
    retireFund: number;
  }>;
  metric: 'attendees' | 'workDays' | 'labor' | 'insurance' | 'retireFund';
  label: string;
  unit: string;
  color: string;
  short?: boolean;
}) {
  const max = Math.max(...rows.map((r) => r[metric]), 1);
  const fmt = (v: number) => (short ? krwShort(v) : v.toLocaleString());
  return (
    <div className="rep__trend">
      <div className="rep__trend-head">
        <span className="rep__trend-title" style={{ color }}>{label}</span>
        <span className="rep__trend-unit">단위: {unit}</span>
      </div>
      <div className="rep__trend-bars">
        {rows.map((r) => {
          const v = r[metric];
          const pct = (v / max) * 100;
          return (
            <div key={r.yearMonth} className="rep__trend-col">
              <div className="rep__trend-val">{fmt(v)}</div>
              <div className="rep__trend-bar-wrap">
                <div
                  className="rep__trend-bar"
                  style={{ height: pct + '%', background: color }}
                  title={`${r.yearMonth}: ${fmt(v)} ${unit}`}
                />
              </div>
              <div className="rep__trend-month">{r.yearMonth.slice(5)}월</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────── 화폐 포맷 ───────── */
function krw(n: number): string {
  if (!n) return '0원';
  return n.toLocaleString() + '원';
}
function krwShort(n: number): string {
  if (!n) return '0';
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + '억';
  if (n >= 10_000) return Math.round(n / 10_000).toLocaleString() + '만';
  return n.toLocaleString();
}
