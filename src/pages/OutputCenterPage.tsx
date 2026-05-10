// FILE_VERSION 1777810002
/**
 * 출력센터 — 흩어져 있는 출력·신고 양식을 한 곳에 모은 페이지
 *
 *  탭 구성
 *   1) 임금·노무   : 노임대장 / 임금명세서 / 근로내용확인신고서 (노임비 페이지 단축)
 *   2) 4대보험     : 일용근로내용 신고서 빌드/다운로드/업로드 + 4insure 토탈서비스 안내
 *   3) 출역·작업   : 출역일보 / 현장별 출역정보 / 작업일보 (PDF/XLSX)
 *   4) 신고 이력   : 모든 발행/업로드 이력 누적 보관 (localStorage)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { siteApi } from '../api/site';
import { wageApi } from '../api/wage';
import { useAuth } from '../hooks/useAuth';
import {
  buildInsuranceFiling,
  downloadInsuranceFilingXlsx,
  parseInsuranceFilingFile,
  loadInsuranceFilingArchive,
  appendInsuranceFilingArchive,
  deleteInsuranceFilingArchive,
  SEPARATION_REASON_LABEL,
  type InsuranceFilingDoc,
  type InsuranceKind,
  type FilingInput,
} from '../utils/insuranceFiling';
import {
  detectInsuranceCycles,
  buildPendingFilings,
  loadReported,
  markReported,
  unmarkReported,
  insuranceTypesShort,
  type AttRecordLite,
  type MemberLite,
} from '../utils/insuranceCycle';
import { FILING_TYPE_LABEL } from '../api/insurance.types';
import { teamApi } from '../api/team';
import type { Site } from '../api/site.types';
import type { WageMonthSummary } from '../api/wage.types';
import './OutputCenterPage.css';

import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
type TabKey = 'WAGE' | 'INSURANCE' | 'WORK' | 'HISTORY';

export function OutputCenterPage({ defaultTab = 'INSURANCE' }: { defaultTab?: TabKey } = {}) {
  const { user } = useAuth();
  const location = useLocation();
  // /insurance 라우트 — 4대보험 전용 모드 (탭 바 숨김 + 제목 「4대보험」)
  const isInsuranceRoute = location.pathname === '/insurance';
  const [tab, setTab] = useState<TabKey>(defaultTab);
  // 라우트 변경(/insurance vs /output) 시 defaultTab sync
  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);
  const [sites, setSites] = useState<Site[]>([]);
  const [archive, setArchive] = useState<InsuranceFilingDoc[]>(loadInsuranceFilingArchive());

  useEffect(() => {
    siteApi
      .listSites()
      .then((res) => setSites(res.sites))
      .catch((e) => console.error('현장 목록 로드 실패', e));
  }, []);

  const refreshArchive = () => setArchive(loadInsuranceFilingArchive());

  const tabs: Array<[TabKey, string, string, number]> = [
    ['WAGE', '💰', '임금·노무', 3],
    ['INSURANCE', '🏛', '4대보험', 1],
    ['WORK', '📋', '출역·작업', 3],
    ['HISTORY', '🗂', '발행 이력', archive.length],
  ];

  return (
    <div className="output">
      <PageHeader
        title={isInsuranceRoute ? '4대보험' : '출력센터'}
        subtitle={isInsuranceRoute
          ? '일용근로내용 신고서 발행·업로드 + 4insure 토탈서비스 안내'
          : '노무대장·신고서·출역일보 등 모든 양식을 한 곳에서 발행·업로드'}
      />

      {/* 탭 바 — /insurance (4대보험) 전용 라우트에서는 숨김 */}
      {!isInsuranceRoute && (
        <div className="output__tabs" role="tablist">
          {tabs.map(([k, icon, label, count]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={'output__tab' + (tab === k ? ' is-active' : '')}
              onClick={() => setTab(k)}
            >
              <span className="output__tab-icon">{icon}</span>
              <span className="output__tab-label">{label}</span>
              <span className="output__tab-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'WAGE' && <WageShortcuts />}
      {tab === 'INSURANCE' && (
        <InsuranceFilingTab
          sites={sites}
          archive={archive}
          companyName={user?.companyName ?? ''}
          managerName={user?.name ?? ''}
          onArchiveChanged={refreshArchive}
        />
      )}
      {tab === 'WORK' && <WorkShortcuts />}
      {tab === 'HISTORY' && (
        <HistoryTab
          archive={archive}
          onArchiveChanged={refreshArchive}
        />
      )}
    </div>
  );
}

/* ───────── 1. 임금·노무 단축 ───────── */

function WageShortcuts() {
  const handleNotReady = () => window.alert('준비중입니다.');
  return (
    <div className="output__panel">
      <p className="output__panel-desc">
        임금 관련 양식은 「노임비」 페이지에서 월·현장 선택 후 발행할 수 있습니다.
      </p>
      <div className="output__shortcut-grid">
        <button type="button" className="output__shortcut" onClick={handleNotReady}>
          <span className="output__shortcut-icon">📄</span>
          <strong>임금명세서</strong>
          <em>월별 일괄 발행 (출력 / 카톡 / SMS)</em>
        </button>
        <button type="button" className="output__shortcut" onClick={handleNotReady}>
          <span className="output__shortcut-icon">🏛</span>
          <strong>근로내용확인신고서</strong>
          <em>고용센터 제출용 PDF</em>
        </button>
        <button type="button" className="output__shortcut" onClick={handleNotReady}>
          <span className="output__shortcut-icon">📚</span>
          <strong>노임대장 (다운/업로드)</strong>
          <em>일용노무비지급명세서 .xlsx</em>
        </button>
      </div>
    </div>
  );
}

/* ───────── 2. 4대보험 신고 ───────── */

function InsuranceFilingTab({
  sites,
  archive,
  companyName,
  managerName,
  onArchiveChanged,
}: {
  sites: Site[];
  archive: InsuranceFilingDoc[];
  companyName: string;
  managerName: string;
  onArchiveChanged: () => void;
}) {
  const today = new Date();
  const [siteId, setSiteId] = useState<string>('');
  const [yearMonth, setYearMonth] = useState<string>(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
  );
  const [insuranceKind, setInsuranceKind] = useState<InsuranceKind>('BOTH');
  const [reportToNts, setReportToNts] = useState(false);
  const [summary, setSummary] = useState<WageMonthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  // 현장 자동 선택 — 첫 진행중 현장
  useEffect(() => {
    if (!siteId && sites.length > 0) {
      const firstActive = sites.find((s) => s.status === 'IN_PROGRESS') ?? sites[0];
      setSiteId(firstActive.id);
    }
  }, [sites, siteId]);

  // 임금 데이터 로드
  useEffect(() => {
    if (!siteId || !yearMonth) return;
    setLoading(true);
    wageApi
      .monthSummary({ siteId, yearMonth })
      .then((d) => setSummary(d))
      .catch((e) => {
        console.error('임금 데이터 로드 실패', e);
        setSummary(null);
      })
      .finally(() => setLoading(false));
  }, [siteId, yearMonth]);

  const currentSite = sites.find((s) => s.id === siteId) ?? null;

  // 신고 행 미리보기
  const filingInputs: FilingInput[] = useMemo(() => {
    if (!summary) return [];
    return summary.rows.map((r) => ({
      name: r.memberName,
      // 평문 주민번호는 권한 체크 후 멤버 API로 별도 가져옴 — 여기선 마스킹된 값
      rrn: r.idNumberMasked.replace(/[^0-9]/g, '').slice(0, 13),
      workDays: r.workDays,
      gross: r.baseAmount,
      incomeTax: r.deductionIncomeTax,
      localTax: r.deductionLocalTax,
      jobCode: undefined, // KECO 직종코드 — 추후 멤버 매핑 추가
      foreigner: false,
    }));
  }, [summary]);

  async function handleBuildAndDownload() {
    if (!summary || filingInputs.length === 0) {
      window.alert('해당 월·현장에 정산 데이터가 없습니다.');
      return;
    }
    setBusy(true);
    try {
      const doc = buildInsuranceFiling({
        rows: filingInputs,
        yearMonth,
        site: currentSite ? { id: currentSite.id, name: currentSite.name } : null,
        companyName,
        managerName,
        insuranceKind,
        reportToNts,
      });
      appendInsuranceFilingArchive(doc);
      onArchiveChanged();
      await downloadInsuranceFilingXlsx(doc);
    } catch (e) {
      console.error(e);
      window.alert('신고서 생성 실패: ' + (e instanceof Error ? e.message : '알 수 없는 오류'));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const doc = await parseInsuranceFilingFile(file);
      appendInsuranceFilingArchive(doc);
      onArchiveChanged();
      window.alert(
        `[${file.name}] 업로드 성공\n· 신고월 ${doc.yearMonth}\n· 인원 ${doc.rows.length}명\n\n* 신고 이력 탭에서 확인할 수 있습니다.`,
      );
    } catch (err) {
      window.alert('업로드 실패: 양식이 다를 수 있습니다.\n' + (err instanceof Error ? err.message : ''));
    } finally {
      setBusy(false);
      if (e.target) e.target.value = '';
      setUploadFile(null);
    }
  }

  return (
    <div className="output__panel">
      <div className="output__filing-grid">
        {/* 좌측 — 빌드 폼 */}
        <div className="card output__filing-card">
          <h3 className="output__filing-h">📤 신고서 빌드 → 4insure 업로드</h3>
          <p className="output__filing-desc">
            아래 조건으로 「근로내용확인신고서」 .xlsx를 빌드합니다. 다운로드한 파일을{' '}
            <a
              href="https://www.4insure.or.kr/"
              target="_blank"
              rel="noreferrer"
              className="output__link"
            >
              4대사회보험 정보연계센터(4insure.or.kr)
            </a>{' '}
            토탈서비스에 업로드하면 신고가 완료됩니다.
          </p>

          <div className="output__field-grid">
            <label className="output__field">
              <span>현장</span>
              <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              options={[...sites.map((s) => (
                  ({ value: s.id, label: s.name })
                ))]}
            />
            </label>
            <label className="output__field">
              <span>신고월</span>
              <MacDatePicker
              value={yearMonth}
              onChange={(v) => setYearMonth(v)}
              type="month"
            />
            </label>
            <label className="output__field">
              <span>보험 종류</span>
              <MacSelect
              value={insuranceKind}
              onChange={(v) => setInsuranceKind(v as InsuranceKind)}
              options={[{ value: "BOTH", label: '산재 + 고용 (5)' }, { value: "EMP", label: '고용보험만 (3)' }, { value: "WC", label: '산재보험만 (1)' }]}
            />
            </label>
            <label className="output__field output__field--check">
              <input
                type="checkbox"
                checked={reportToNts}
                onChange={(e) => setReportToNts(e.target.checked)}
              />
              <span>국세청 일용근로소득도 함께 신고 (Y)</span>
            </label>
          </div>

          <div className="output__filing-summary">
            {loading ? (
              <p>임금 데이터 불러오는 중…</p>
            ) : summary && filingInputs.length > 0 ? (
              <>
                <strong>{filingInputs.length}명</strong>의 신고 대상 ·{' '}
                근로일수 합계{' '}
                <strong>{filingInputs.reduce((s, r) => s + r.workDays, 0)}</strong>일 ·{' '}
                보수총액{' '}
                <strong>
                  {filingInputs
                    .reduce((s, r) => s + r.gross, 0)
                    .toLocaleString()}
                  원
                </strong>
              </>
            ) : (
              <em className="output__muted">선택한 월·현장에 정산 데이터가 없습니다.</em>
            )}
          </div>

          <div className="output__filing-actions">
            <button
              type="button"
              className="output__btn output__btn--primary"
              onClick={handleBuildAndDownload}
              disabled={busy || filingInputs.length === 0}
            >
              {busy ? '생성 중…' : '⬇ 신고서 .xlsx 다운로드'}
            </button>
            <a
              href="https://total.kcomwel.or.kr/"
              target="_blank"
              rel="noreferrer"
              className="output__btn output__btn--ghost"
            >
              🔗 고용·산재 토탈서비스 열기
            </a>
          </div>

          <details className="output__hint">
            <summary>📘 작성 안내 (이직사유·체류자격·직종코드)</summary>
            <ul>
              <li>
                <strong>이직사유</strong> 코드:{' '}
                {Object.entries(SEPARATION_REASON_LABEL)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')}
              </li>
              <li>
                <strong>직종코드</strong> — KECO 2025 소분류 140개 (기본 '013' 건설일반).
                4insure.or.kr → 자료실 → 직종코드표 참조
              </li>
              <li>
                <strong>국적</strong> — 내국인 '100'. 외국인은 4insure 국적코드표 참조
              </li>
              <li>
                <strong>체류자격</strong> — F-4, E-9 등 232종 (양식 시트 「체류자격」 참조)
              </li>
            </ul>
          </details>
        </div>

        {/* 우측 — 업로드 카드 */}
        <div className="card output__filing-card">
          <h3 className="output__filing-h">📥 신고 결과 업로드</h3>
          <p className="output__filing-desc">
            토탈서비스에서 신고 후 회신받은 .xlsx 파일을 업로드하면 발행 이력에 보관됩니다.
            추후 사고/감사 시 「발행 이력」 탭에서 다시 다운로드할 수 있습니다.
          </p>
          <div className="output__upload-zone">
            <input
              type="file"
              accept=".xlsx,.xls"
              id="output-insurance-upload"
              style={{ display: 'none' }}
              onChange={handleUpload}
            />
            <label htmlFor="output-insurance-upload" className="output__btn output__btn--primary">
              ⬆ .xlsx 파일 선택
            </label>
            {uploadFile && <span className="output__muted">{uploadFile.name}</span>}
          </div>

          <div className="output__divider" />

          <h4 className="output__sub-h">📋 진행 가이드</h4>
          <ol className="output__guide">
            <li>
              <strong>① 빌드</strong> — 좌측에서 현장·월·보험종류 선택 후 다운로드
            </li>
            <li>
              <strong>② 업로드</strong> — 토탈서비스 「전자매체신고」 메뉴에 .xlsx 업로드
            </li>
            <li>
              <strong>③ 검증</strong> — 시스템에서 오류 확인 → 수정 후 재업로드
            </li>
            <li>
              <strong>④ 회신 보관</strong> — 신고 완료 회신 파일을 우측에 업로드해 보관
            </li>
          </ol>
        </div>
      </div>

      {/* 자격 사이클 추적 — 8일룰 자동 감지 */}
      <InsuranceCycleCard sites={sites} />

      {/* 최근 발행 이력 미리보기 */}
      <div className="card output__recent">
        <header className="output__recent-head">
          <strong>최근 발행 이력</strong>
          <span className="output__muted">총 {archive.length}건 — 최근 5건</span>
        </header>
        {archive.length === 0 ? (
          <p className="output__muted output__recent-empty">아직 발행한 4대보험 신고서가 없습니다.</p>
        ) : (
          <ul className="output__recent-list">
            {archive
              .slice()
              .reverse()
              .slice(0, 5)
              .map((d) => (
                <li key={d.id} className="output__recent-item">
                  <span className="output__recent-time">
                    {d.builtAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  <span className="output__recent-tag">
                    {d.insuranceKind === 'BOTH'
                      ? '산재+고용'
                      : d.insuranceKind === 'EMP'
                        ? '고용'
                        : '산재'}
                  </span>
                  <span className="output__recent-month">{d.yearMonth}</span>
                  <span className="output__recent-site">{d.siteName}</span>
                  <span className="output__recent-meta">{d.rows.length}명</span>
                  {d.responseUploaded ? (
                    <span className="output__recent-resp">✓ 회신 보관</span>
                  ) : (
                    <span className="output__recent-pend">발송 대기</span>
                  )}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ───────── 3. 출역·작업 ───────── */

function WorkShortcuts() {
  return (
    <div className="output__panel">
      <p className="output__panel-desc">
        출역 / 작업 관련 양식은 출퇴근 화면에서 바로 발행하거나, 추후 이 탭에서 통합 발행 예정입니다.
      </p>
      <div className="output__shortcut-grid">
        <Link to="/attendance" className="output__shortcut">
          <span className="output__shortcut-icon">📅</span>
          <strong>출역일보</strong>
          <em>일자별 출력 인원·공수</em>
        </Link>
        <Link to="/attendance" className="output__shortcut">
          <span className="output__shortcut-icon">📊</span>
          <strong>현장별 출역정보</strong>
          <em>월간 / 직종별 합계</em>
        </Link>
        <Link to="/attendance" className="output__shortcut output__shortcut--planned">
          <span className="output__shortcut-icon">📝</span>
          <strong>작업일보 (예정)</strong>
          <em>날씨·진척도·현장사진</em>
        </Link>
      </div>
    </div>
  );
}

/* ───────── 4. 발행 이력 ───────── */

function HistoryTab({
  archive,
  onArchiveChanged,
}: {
  archive: InsuranceFilingDoc[];
  onArchiveChanged: () => void;
}) {
  function handleDelete(id: string) {
    if (!window.confirm('이 발행 이력을 삭제하시겠습니까?')) return;
    deleteInsuranceFilingArchive(id);
    onArchiveChanged();
  }

  async function handleRedownload(d: InsuranceFilingDoc) {
    try {
      await downloadInsuranceFilingXlsx(d);
    } catch (e) {
      window.alert('재다운로드 실패: ' + (e instanceof Error ? e.message : ''));
    }
  }

  return (
    <div className="output__panel">
      <div className="card">
        {archive.length === 0 ? (
          <p className="output__muted output__recent-empty">아직 발행/업로드 이력이 없습니다.</p>
        ) : (
          <table className="output__history-table">
            <thead>
              <tr>
                <th>발행시각</th>
                <th>구분</th>
                <th>신고월</th>
                <th>현장</th>
                <th>인원</th>
                <th>회신</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {archive
                .slice()
                .reverse()
                .map((d) => (
                  <tr key={d.id}>
                    <td>{d.builtAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>
                      <span className="output__recent-tag">
                        {d.insuranceKind === 'BOTH'
                          ? '산재+고용'
                          : d.insuranceKind === 'EMP'
                            ? '고용'
                            : '산재'}
                      </span>
                    </td>
                    <td>{d.yearMonth}</td>
                    <td>{d.siteName}</td>
                    <td className="num">{d.rows.length}명</td>
                    <td>
                      {d.responseUploaded ? (
                        <span className="output__recent-resp">
                          ✓ {d.responseUploaded.uploadedAt.slice(0, 10)}
                        </span>
                      ) : (
                        <span className="output__recent-pend">대기</span>
                      )}
                    </td>
                    <td className="output__history-action">
                      <button
                        type="button"
                        className="output__btn output__btn--xs output__btn--ghost"
                        onClick={() => handleRedownload(d)}
                      >
                        ⬇ 재다운
                      </button>
                      <button
                        type="button"
                        className="output__btn output__btn--xs output__btn--danger"
                        onClick={() => handleDelete(d.id)}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ───────── 자격 사이클 추적 카드 (4대보험 탭 내부) ───────── */

function InsuranceCycleCard({ sites }: { sites: Site[] }) {
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [tasks, setTasks] = useState<ReturnType<typeof buildPendingFilings>>([]);
  const [loading, setLoading] = useState(true);
  const [reportedTick, setReportedTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const allMembers: MemberLite[] = [];
        const cycles: ReturnType<typeof detectInsuranceCycles> = [];
        // 활성·시공중 현장 한정
        const activeSites = sites.filter((s) => s.status !== 'COMPLETED');
        for (const site of activeSites) {
          const teamRes = await teamApi.list({ siteId: site.id, status: 'ALL' });
          for (const m of teamRes.members) {
            const memberLite: MemberLite = {
              id: m.id,
              name: m.name,
              siteId: site.id,
              status: m.status,
              joinedAt: m.joinedAt,
              leftAt: m.leftAt,
            };
            allMembers.push(memberLite);
            // 그 멤버의 attendance — 최근 3개월 (간단)
            const records: AttRecordLite[] = [];
            const now = new Date();
            for (let off = 0; off >= -2; off--) {
              const dt = new Date(now.getFullYear(), now.getMonth() + off, 1);
              const ym =
                dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
              const bucketKey = `bodapass.attendance.${site.id}.${ym}`;
              try {
                const raw = localStorage.getItem(bucketKey);
                if (!raw) continue;
                const bucket = JSON.parse(raw);
                for (const r of Object.values(bucket.records ?? {}) as Array<{
                  memberId: string;
                  date: string;
                  status: AttRecordLite['status'];
                  gongsu: number;
                }>) {
                  if (r.memberId !== m.id) continue;
                  records.push({
                    date: r.date,
                    status: r.status,
                    gongsu: r.gongsu,
                  });
                }
              } catch (e) {
                console.error(e);
              }
            }
            const memberCycles = detectInsuranceCycles(memberLite, records);
            cycles.push(...memberCycles);
          }
        }
        if (cancelled) return;
        // 신고 완료 이력 반영
        const reported = loadReported();
        for (const c of cycles) {
          const ack = reported.find(
            (r) => r.cycleId === c.id && r.type === 'ACQUIRE',
          );
          const lose = reported.find((r) => r.cycleId === c.id && r.type === 'LOSE');
          if (ack) c.reportedAcquireAt = ack.reportedAt;
          if (lose) c.reportedLoseAt = lose.reportedAt;
        }
        const membersById = new Map(allMembers.map((x) => [x.id, x] as const));
        const sitesById = new Map(
          activeSites.map((s) => [s.id, { id: s.id, name: s.name }] as const),
        );
        const pending = buildPendingFilings(cycles, membersById, sitesById);
        setMembers(allMembers);
        setTasks(pending);
      } catch (e) {
        console.error('자격 사이클 분석 실패', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sites, reportedTick]);

  function handleMark(taskId: string, type: 'ACQUIRE' | 'LOSE') {
    const cycleId = taskId.replace(/^T-/, '').replace(/-[AL]$/, '');
    markReported(cycleId, type);
    setReportedTick((t) => t + 1);
  }

  function handleUnmark(taskId: string, type: 'ACQUIRE' | 'LOSE') {
    const cycleId = taskId.replace(/^T-/, '').replace(/-[AL]$/, '');
    unmarkReported(cycleId, type);
    setReportedTick((t) => t + 1);
  }

  void members;

  return (
    <div className="card output__cycle">
      <header className="output__cycle-head">
        <strong>🏛 4대보험 자격 사이클 추적</strong>
        <span className="output__muted">
          8일룰 자동 감지 — 한 달 8일 이상 근무 시 자격취득, 이탈 시 자격상실
        </span>
        {tasks.length > 0 && (
          <span className="output__cycle-badge">{tasks.length}건 대기</span>
        )}
      </header>
      {loading ? (
        <p className="output__muted output__cycle-empty">분석 중…</p>
      ) : tasks.length === 0 ? (
        <p className="output__muted output__cycle-empty">
          현재 신고 대기 중인 자격취득/상실이 없습니다. ✓ 모든 신고가 완료되었습니다.
        </p>
      ) : (
        <table className="output__cycle-table">
          <thead>
            <tr>
              <th>구분</th>
              <th>근로자</th>
              <th>현장</th>
              <th>발생일</th>
              <th>적용 보험</th>
              <th>마감</th>
              <th>사유</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>
                  <span
                    className={
                      'output__cycle-tag output__cycle-tag--' + t.type.toLowerCase()
                    }
                  >
                    {FILING_TYPE_LABEL[t.type]}
                  </span>
                </td>
                <td className="output__cycle-name">{t.memberName}</td>
                <td>{t.siteName}</td>
                <td>{t.date}</td>
                <td>{insuranceTypesShort(t.insuranceTypes)}</td>
                <td>{t.dueBy}</td>
                <td className="output__muted small">{t.reason}</td>
                <td className="output__cycle-action">
                  <button
                    type="button"
                    className="output__btn output__btn--xs output__btn--primary"
                    onClick={() =>
                      handleMark(t.id, t.type === 'ACQUIRE' ? 'ACQUIRE' : 'LOSE')
                    }
                  >
                    ✓ 신고완료 표시
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReportedHistory onUnmark={handleUnmark} />
    </div>
  );
}

function ReportedHistory({
  onUnmark,
}: {
  onUnmark: (taskId: string, type: 'ACQUIRE' | 'LOSE') => void;
}) {
  const [items, setItems] = useState(() => loadReported());
  useEffect(() => {
    const id = setInterval(() => setItems(loadReported()), 1000);
    return () => clearInterval(id);
  }, []);
  if (items.length === 0) return null;
  return (
    <details className="output__cycle-reported">
      <summary>✓ 신고 완료 이력 ({items.length}건)</summary>
      <ul>
        {items
          .slice()
          .reverse()
          .slice(0, 20)
          .map((r) => (
            <li key={r.cycleId + r.type}>
              <span>{r.cycleId.replace(/^IC-/, '')}</span>
              <span className="output__cycle-tag output__cycle-tag--small">
                {FILING_TYPE_LABEL[r.type]}
              </span>
              <span className="output__muted small">
                {r.reportedAt.slice(0, 10)}
              </span>
              <button
                type="button"
                className="output__btn output__btn--xs output__btn--ghost"
                onClick={() => onUnmark('T-' + r.cycleId, r.type)}
              >
                해제
              </button>
            </li>
          ))}
      </ul>
    </details>
  );
}
