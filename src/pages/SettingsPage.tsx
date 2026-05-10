// FILE_VERSION 1777629000
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { PhoneInput } from '../components/PhoneInput';
import { AddressField } from '../components/AddressField';
import { NumberStepper } from '../components/NumberStepper';
import { siteApi } from '../api/site';
import type { Site } from '../api/site.types';
import { displayPhone, formatPhone } from '../utils/phone';
import {
  AccountPermissionDialog,
  defaultPermissions,
  PERM_LABELS,
  type AccountPermissions,
  type PermissionLevel,
} from './settings/AccountPermissionDialog';
import {
  loadFundDaily,
  saveFundDaily,
  DEFAULT_FUND_DAILY,
} from '../utils/severance';
import './SettingsPage.css';

import { MacSelect } from '../components/MacSelect';
/**
 * 설정 페이지
 *  탭: 출퇴근시간 관리 / 세율 관리 / 계정 관리 / 회사 정보
 *  - localStorage 영속 (시연용)
 */

type TabKey = 'attendance' | 'tax' | 'account' | 'company';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'attendance', label: '출퇴근시간 관리', icon: '🕒' },
  { key: 'tax',        label: '세율 관리',         icon: '📊' },
  { key: 'account',    label: '계정 관리',         icon: '👤' },
  { key: 'company',    label: '회사 정보',         icon: '🏢' },
];

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as TabKey) || 'attendance';
  const [tab, setTab] = useState<TabKey>(
    TABS.some((t) => t.key === initialTab) ? initialTab : 'attendance',
  );

  // URL의 ?tab=... 변경에 반응 (외부 링크로 진입 시)
  useEffect(() => {
    const fromUrl = searchParams.get('tab') as TabKey | null;
    if (fromUrl && TABS.some((t) => t.key === fromUrl) && fromUrl !== tab) {
      setTab(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function changeTab(t: TabKey) {
    setTab(t);
    setSearchParams({ tab: t }, { replace: true });
  }

  return (
    <div className="settings">
      <PageHeader
        title="설정"
        subtitle="출퇴근 시간 / 세율 / 관리자 계정 / 회사 정보 관리"
      />

      <div className="settings__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={'settings__tab' + (tab === t.key ? ' is-active' : '')}
            onClick={() => changeTab(t.key)}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings__panel">
        {tab === 'attendance' && <AttendanceShiftPanel />}
        {tab === 'tax' && (
          <>
            <TaxRatePanel />
            <MutualAidFundPanel />
          </>
        )}
        {tab === 'account' && <AccountPanel />}
        {tab === 'company' && <CompanyInfoPanel />}
      </div>
    </div>
  );
}

/* ───────── ① 출퇴근시간 관리 ───────── */

interface ShiftRow {
  id: string;
  siteId: string | null; // null = 전체 현장 공통
  siteName: string;
  type: '주간' | '야간' | '초과';
  weight: number;
  startTime: string; // 'HH:MM:SS'
  endTime: string;
}

const SHIFT_KEY = 'ilgampack_admin:shifts';

function loadShifts(): ShiftRow[] {
  try {
    const raw = localStorage.getItem(SHIFT_KEY);
    if (raw) return JSON.parse(raw) as ShiftRow[];
  } catch { /* ignore */ }
  return [
    { id: 'SH-1', siteId: null, siteName: '전체 현장', type: '주간', weight: 1.0, startTime: '06:00:00', endTime: '16:59:59' },
    { id: 'SH-2', siteId: null, siteName: '전체 현장', type: '야간', weight: 1.5, startTime: '17:00:00', endTime: '23:59:59' },
    { id: 'SH-3', siteId: null, siteName: '전체 현장', type: '초과', weight: 2.0, startTime: '00:00:00', endTime: '04:00:00' },
  ];
}
function saveShifts(rows: ShiftRow[]) {
  try { localStorage.setItem(SHIFT_KEY, JSON.stringify(rows)); } catch { /* ignore */ }
}

function AttendanceShiftPanel() {
  const [rows, setRows] = useState<ShiftRow[]>(() => loadShifts());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sites, setSites] = useState<Site[]>([]);

  useEffect(() => {
    siteApi.listSites().then((r) => setSites(r.sites)).catch(() => {});
  }, []);

  const filtered = rows.filter((r) =>
    !search.trim() ||
    r.siteName.toLowerCase().includes(search.trim().toLowerCase()) ||
    r.type.includes(search.trim()),
  );

  function handleSave(r: ShiftRow) {
    const next = rows.map((x) => (x.id === r.id ? r : x));
    setRows(next);
    saveShifts(next);
    setEditingId(null);
  }
  function handleAdd() {
    const id = 'SH-' + Date.now().toString(36);
    const next: ShiftRow[] = [
      ...rows,
      { id, siteId: null, siteName: '전체 현장', type: '주간', weight: 1.0, startTime: '08:00:00', endTime: '17:00:00' },
    ];
    setRows(next);
    saveShifts(next);
    setEditingId(id);
  }
  function handleDelete(id: string) {
    if (!window.confirm('이 행을 삭제하시겠습니까?')) return;
    const next = rows.filter((x) => x.id !== id);
    setRows(next);
    saveShifts(next);
  }

  return (
    <section className="set-card">
      <header className="set-card__head">
        <div className="set-card__head-left">
          <h3>출퇴근시간 관리</h3>
          <p>현장별 근로 유형(주간/야간/초과)과 가중치, 적용 시간을 정의합니다.</p>
        </div>
        <div className="set-card__head-right">
          <input
            className="set-card__search"
            type="text"
            placeholder="현장명·근로유형 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="set-card__btn set-card__btn--primary" onClick={handleAdd}>
            + 행 추가
          </button>
        </div>
      </header>

      <div className="set-table-wrap">
        <table className="set-table">
          <colgroup>
            <col style={{ width: '28%' }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 100 }} />
          </colgroup>
          <thead>
            <tr>
              <th>현장명</th>
              <th>근로유형</th>
              <th>근로유형별 가중치</th>
              <th>작업 시작 일시</th>
              <th>작업 종료 일시</th>
              <th>수정</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="set-table__empty">데이터가 없습니다.</td></tr>
            ) : (
              filtered.map((r) => {
                const editing = editingId === r.id;
                return (
                  <tr key={r.id} className={editing ? 'is-editing' : ''}>
                    <td>
                      {editing ? (
                        <MacSelect
              value={r.siteId ?? ''}
              onChange={(v) => {
                            const sid = v || null;
                            const sn = sid ? sites.find((s) => s.id === sid)?.name ?? '' : '전체 현장';
                            setRows((p) => p.map((x) => x.id === r.id ? { ...x, siteId: sid, siteName: sn } : x));
                          }}
              options={[{ value: "", label: '전체 현장' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
            />
                      ) : r.siteName}
                    </td>
                    <td>
                      {editing ? (
                        <MacSelect
              value={r.type}
              onChange={(v) => setRows((p) => p.map((x) => x.id === r.id ? { ...x, type: v as ShiftRow['type'] } : x))
                          }
              options={[{ value: '', label: '주간' }, { value: '', label: '야간' }, { value: '', label: '초과' }]}
            />
                      ) : (
                        <span className={'shift-chip shift-chip--' + (r.type === '주간' ? 'day' : r.type === '야간' ? 'night' : 'extra')}>
                          {r.type}
                        </span>
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <NumberStepper
                          step={0.05}
                          min={0}
                          value={r.weight}
                          onChange={(next) =>
                            setRows((p) => p.map((x) => x.id === r.id ? { ...x, weight: next } : x))
                          }
                        />
                      ) : r.weight.toFixed(2)}
                    </td>
                    <td>
                      {editing ? (
                        <input
                          type="time"
                          step={1}
                          value={r.startTime}
                          onChange={(e) =>
                            setRows((p) => p.map((x) => x.id === r.id ? { ...x, startTime: e.target.value } : x))
                          }
                        />
                      ) : r.startTime}
                    </td>
                    <td>
                      {editing ? (
                        <input
                          type="time"
                          step={1}
                          value={r.endTime}
                          onChange={(e) =>
                            setRows((p) => p.map((x) => x.id === r.id ? { ...x, endTime: e.target.value } : x))
                          }
                        />
                      ) : r.endTime}
                    </td>
                    <td className="set-table__action">
                      {editing ? (
                        <>
                          <button type="button" className="set-icon-btn set-icon-btn--save" onClick={() => handleSave(r)} title="저장">✓</button>
                          <button type="button" className="set-icon-btn" onClick={() => setEditingId(null)} title="취소">×</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="set-icon-btn" onClick={() => setEditingId(r.id)} title="수정">✏️</button>
                          <button type="button" className="set-icon-btn set-icon-btn--danger" onClick={() => handleDelete(r.id)} title="삭제">🗑</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ───────── ② 세율 관리 ───────── */

interface TaxRow {
  id: string;
  label: string;
  rate: number; // %
  basis: string;
  description: string;
}

const TAX_KEY = 'ilgampack_admin:taxRates';

function loadTax(): TaxRow[] {
  try {
    const raw = localStorage.getItem(TAX_KEY);
    if (raw) return JSON.parse(raw) as TaxRow[];
  } catch { /* ignore */ }
  return [
    { id: 'TAX-1', label: '소득세 (일용)',   rate: 6,   basis: '일급 - 비과세 15만원', description: '하루 일당이 15만원 초과분의 6% 원천징수' },
    { id: 'TAX-2', label: '주민세',          rate: 0.6, basis: '소득세의 10%',           description: '소득세에 비례한 지방세 (시연: 0.6% 단순화)' },
    { id: 'TAX-3', label: '국민연금',        rate: 4.5, basis: '월 평균보수',            description: '근로자 부담분 (4.5%)' },
    { id: 'TAX-4', label: '건강보험',        rate: 3.545, basis: '월 평균보수',          description: '근로자 부담분 (3.545%)' },
    { id: 'TAX-5', label: '장기요양보험',    rate: 0.4591, basis: '건강보험료의 12.95%', description: '근로자 부담분' },
    { id: 'TAX-6', label: '고용보험',        rate: 0.9, basis: '월 평균보수',            description: '근로자 부담분' },
    { id: 'TAX-7', label: '40H 공단 분담금', rate: 0.5, basis: '도급금액',               description: '건설근로자공제회 적립' },
  ];
}
function saveTax(rows: TaxRow[]) {
  try { localStorage.setItem(TAX_KEY, JSON.stringify(rows)); } catch { /* ignore */ }
}

function TaxRatePanel() {
  const [rows, setRows] = useState<TaxRow[]>(() => loadTax());
  const [editing, setEditing] = useState(false);

  function handleChange(id: string, patch: Partial<TaxRow>) {
    setRows((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
  }
  function handleSave() {
    saveTax(rows);
    setEditing(false);
    window.alert('세율 정보가 저장되었습니다.');
  }
  function handleCancel() {
    setRows(loadTax());
    setEditing(false);
  }

  return (
    <section className="set-card">
      <header className="set-card__head">
        <div className="set-card__head-left">
          <h3>세율 관리</h3>
          <p>임금 계산에 적용되는 세금·공제 항목과 비율을 관리합니다.</p>
        </div>
        <div className="set-card__head-right">
          {!editing ? (
            <button type="button" className="set-card__btn set-card__btn--edit" onClick={() => setEditing(true)}>✎ 수정</button>
          ) : (
            <>
              <button type="button" className="set-card__btn set-card__btn--primary" onClick={handleSave}>💾 저장</button>
              <button type="button" className="set-card__btn" onClick={handleCancel}>취소</button>
            </>
          )}
        </div>
      </header>

      <div className="set-table-wrap">
        <table className="set-table">
          <colgroup>
            <col style={{ width: '20%' }} />
            <col style={{ width: 100 }} />
            <col style={{ width: '25%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>항목</th>
              <th>세율 (%)</th>
              <th>과세 기준</th>
              <th>설명</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="set-table__label">{r.label}</td>
                <td>
                  {editing ? (
                    <NumberStepper
                      step={0.001}
                      min={0}
                      value={r.rate}
                      onChange={(next) => handleChange(r.id, { rate: next })}
                    />
                  ) : (
                    <span className="tax-rate">{r.rate.toFixed(3).replace(/\.?0+$/, '') || '0'}%</span>
                  )}
                </td>
                <td>
                  {editing ? (
                    <input
                      type="text"
                      value={r.basis}
                      onChange={(e) => handleChange(r.id, { basis: e.target.value })}
                    />
                  ) : r.basis}
                </td>
                <td className="set-table__desc">
                  {editing ? (
                    <input
                      type="text"
                      value={r.description}
                      onChange={(e) => handleChange(r.id, { description: e.target.value })}
                    />
                  ) : r.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ───────── ②-2 퇴직공제부금 일액 ───────── */

function MutualAidFundPanel() {
  const [value, setValue] = useState<number>(() => loadFundDaily());
  const [draft, setDraft] = useState<string>(() => String(loadFundDaily()));
  const [editing, setEditing] = useState(false);

  function start() {
    setDraft(String(value));
    setEditing(true);
  }
  function cancel() {
    setDraft(String(value));
    setEditing(false);
  }
  function save() {
    const n = Number(String(draft).replace(/[^0-9]/g, ''));
    if (!isFinite(n) || n <= 0) {
      window.alert('1원 이상 정수 금액을 입력해주세요.');
      return;
    }
    saveFundDaily(n);
    setValue(n);
    setEditing(false);
    window.alert('부금 일액이 저장되었습니다.');
  }
  function resetDefault() {
    if (!window.confirm(`기본값(${DEFAULT_FUND_DAILY.toLocaleString()}원)으로 되돌릴까요?`)) return;
    saveFundDaily(DEFAULT_FUND_DAILY);
    setValue(DEFAULT_FUND_DAILY);
    setDraft(String(DEFAULT_FUND_DAILY));
    setEditing(false);
  }

  return (
    <section className="set-card" style={{ marginTop: 20 }}>
      <header className="set-card__head">
        <div className="set-card__head-left">
          <h3>퇴직공제부금 일액</h3>
          <p>
            건설근로자공제회에 신고·납부하는 일용근로자 퇴직공제부금의 「출역 1일당 금액」입니다.
            계속근로 1년 미만 근로자에게만 적용되며, 1년 도래 시점부터 신고가 중단되고 법정퇴직금으로 전환됩니다.
          </p>
        </div>
        <div className="set-card__head-right">
          {!editing ? (
            <>
              <button type="button" className="set-card__btn set-card__btn--edit" onClick={start}>✎ 수정</button>
              <button type="button" className="set-card__btn" onClick={resetDefault}>기본값으로</button>
            </>
          ) : (
            <>
              <button type="button" className="set-card__btn set-card__btn--primary" onClick={save}>💾 저장</button>
              <button type="button" className="set-card__btn" onClick={cancel}>취소</button>
            </>
          )}
        </div>
      </header>

      <div style={{ padding: '12px 18px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#6b6b73', fontWeight: 600 }}>현재 적용 일액</span>
          {editing ? (
            <input
              type="text"
              inputMode="numeric"
              value={draft ? Number(draft.replace(/[^0-9]/g, '') || '0').toLocaleString() : ''}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="6,500"
              style={{
                width: 140,
                height: 36,
                padding: '0 12px',
                border: '1px solid #d2d2d7',
                borderRadius: 8,
                fontSize: 14,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          ) : (
            <strong style={{ fontSize: 22, color: '#007aff', fontVariantNumeric: 'tabular-nums' }}>
              {value.toLocaleString()}
            </strong>
          )}
          <span style={{ fontSize: 14, color: '#1c1c1e' }}>원 / 출역일</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: '#8e8e93',
            background: '#f5f5f7',
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid #e5e5ea',
          }}
        >
          예: 한 달 22일 출역 시 → {(value * 22).toLocaleString()}원
          <span style={{ marginLeft: 8 }}>· 정책 변경 시 본 화면에서 수정</span>
        </div>
      </div>
    </section>
  );
}

/* ───────── ③ 계정 관리 ───────── */

interface AccountRow {
  id: string;
  externalId: string;
  name: string;
  phone: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  createdAt: string;
  permissions?: AccountPermissions;
}
const ACCOUNT_KEY = 'ilgampack_admin:accounts';

function loadAccounts(): AccountRow[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (raw) return JSON.parse(raw) as AccountRow[];
  } catch { /* ignore */ }
  return [
    { id: 'A-1', externalId: 'akoma',  name: '아코마',   phone: '010-1234-5678', role: 'OWNER',   createdAt: '2024-10-01' },
    { id: 'A-2', externalId: 'kwlghd', name: '김지홍',   phone: '010-9876-5432', role: 'MANAGER', createdAt: '2025-03-15' },
  ];
}
function saveAccounts(rows: AccountRow[]) {
  try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(rows)); } catch { /* ignore */ }
}

function AccountPanel() {
  const [rows, setRows] = useState<AccountRow[]>(() => loadAccounts());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [permFor, setPermFor] = useState<AccountRow | null>(null);
  const [sites, setSites] = useState<Site[]>([]);

  useEffect(() => {
    siteApi.listSites().then((r) => setSites(r.sites)).catch(() => {});
  }, []);

  function siteLabel(scope: AccountPermissions['scope'] | undefined) {
    if (!scope || scope === 'ALL') return '전체 현장';
    return sites.find((s) => s.id === scope)?.name ?? scope;
  }

  function handleAdd(a: Omit<AccountRow, 'id' | 'createdAt'>) {
    const id = 'A-' + Date.now().toString(36);
    const next: AccountRow[] = [
      ...rows,
      { ...a, id, createdAt: new Date().toISOString().slice(0, 10), permissions: defaultPermissions() },
    ];
    setRows(next);
    saveAccounts(next);
  }
  function handleDelete(id: string) {
    if (!window.confirm('이 관리자 계정을 삭제하시겠습니까?')) return;
    const next = rows.filter((x) => x.id !== id);
    setRows(next);
    saveAccounts(next);
  }
  function handleSavePerm(perm: AccountPermissions) {
    if (!permFor) return;
    const next = rows.map((x) => (x.id === permFor.id ? { ...x, permissions: perm } : x));
    setRows(next);
    saveAccounts(next);
    setPermFor(null);
  }

  return (
    <section className="set-card">
      <header className="set-card__head">
        <div className="set-card__head-left">
          <h3>계정 관리</h3>
          <p>이 회사에서 일당백 관리자 웹에 로그인할 수 있는 계정 목록입니다.</p>
        </div>
        <div className="set-card__head-right">
          <button
            type="button"
            className="set-card__btn set-card__btn--primary"
            onClick={() => setDialogOpen(true)}
          >
            + 관리자 등록
          </button>
        </div>
      </header>

      <div className="set-table-wrap">
        <table className="set-table">
          <colgroup>
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 130 }} />
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <th>외부 사용자 ID</th>
              <th>사원명</th>
              <th>전화번호</th>
              <th>권한</th>
              <th>배정 현장</th>
              <th>사용 가능 권한</th>
              <th>등록일</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const perm = r.permissions ?? defaultPermissions();
              const summary = summarizePerm(perm);
              return (
                <tr key={r.id}>
                  <td className="set-table__label">{r.externalId}</td>
                  <td>{r.name}</td>
                  <td>{displayPhone(r.phone)}</td>
                  <td>
                    <span className={'role-chip role-chip--' + r.role.toLowerCase()}>
                      {r.role === 'OWNER' ? '소유자' : r.role === 'MANAGER' ? '현장담당자' : '스태프'}
                    </span>
                  </td>
                  <td>
                    <span className={'site-chip' + (perm.scope === 'ALL' ? ' site-chip--all' : '')}>
                      {perm.scope === 'ALL' ? '🏢 전체 현장' : '📍 ' + siteLabel(perm.scope)}
                    </span>
                  </td>
                  <td>
                    <div className="perm-summary">
                      <PermPill level="전체기능이용" labels={summary.full}     count={summary.full.length} />
                      <PermPill level="조회"        labels={summary.read}     count={summary.read.length} />
                      <PermPill level="이용제한"    labels={summary.restrict} count={summary.restrict.length} />
                    </div>
                  </td>
                  <td>{r.createdAt}</td>
                  <td className="set-table__action">
                    <button
                      type="button"
                      className="set-icon-btn"
                      onClick={() => setPermFor(r)}
                      title="권한 설정"
                    >
                      ⚙
                    </button>
                    <button
                      type="button"
                      className="set-icon-btn set-icon-btn--danger"
                      onClick={() => handleDelete(r.id)}
                      disabled={r.role === 'OWNER'}
                      title={r.role === 'OWNER' ? '소유자는 삭제할 수 없습니다' : '계정 삭제'}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialogOpen && (
        <AdminRegisterDialog
          onClose={() => setDialogOpen(false)}
          onConfirm={(data) => {
            handleAdd(data);
            setDialogOpen(false);
          }}
        />
      )}

      {permFor && (
        <AccountPermissionDialog
          accountName={permFor.name}
          accountId={permFor.externalId}
          initial={permFor.permissions ?? defaultPermissions()}
          onClose={() => setPermFor(null)}
          onSave={handleSavePerm}
        />
      )}
    </section>
  );
}

function AdminRegisterDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (data: Omit<AccountRow, 'id' | 'createdAt'>) => void;
}) {
  const [externalId, setExternalId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showPwConfirm, setShowPwConfirm] = useState(false);
  const [role, setRole] = useState<AccountRow['role']>('MANAGER');

  const valid = useMemo(() => {
    if (!externalId.trim() || !name.trim()) return false;
    if (pw.length === 0 || pw !== pwConfirm) return false;
    return true;
  }, [externalId, name, pw, pwConfirm]);

  function handleSubmit() {
    if (!valid) {
      window.alert('아이디·이름과 비밀번호를 입력하고, 비밀번호 확인까지 일치시켜 주세요.');
      return;
    }
    onConfirm({ externalId: externalId.trim(), name: name.trim(), phone: phone.trim(), role });
  }

  return (
    <div
      className="set-modal__backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="set-modal">
        <header className="set-modal__head">
          <h3>관리자 등록</h3>
          <button type="button" className="set-modal__x" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <div className="set-modal__body">
          <div className="set-modal__field">
            <label>외부 사용자 ID <em>*</em></label>
            <input
              type="text"
              placeholder="ID를 입력하세요."
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
          </div>
          <div className="set-modal__field">
            <label>사원명 <em>*</em></label>
            <input
              type="text"
              placeholder="이름을 입력하세요."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="set-modal__field">
            <label>전화번호</label>
            <PhoneInput
              placeholder="숫자만 입력하면 자동으로 - 가 붙습니다"
              value={phone}
              onChange={setPhone}
            />
          </div>
          <div className="set-modal__field">
            <label>권한</label>
            <MacSelect
              value={role}
              onChange={(v) => setRole(v as AccountRow['role'])}
              options={[{ value: "MANAGER", label: '현장담당자' }, { value: "STAFF", label: '스태프' }]}
            />
          </div>
          <PasswordField
            label="사원 비밀번호"
            required
            value={pw}
            onChange={setPw}
            show={showPw}
            onToggleShow={() => setShowPw((v) => !v)}
          />
          <PasswordField
            label="사원 비밀번호 확인"
            required
            value={pwConfirm}
            onChange={setPwConfirm}
            show={showPwConfirm}
            onToggleShow={() => setShowPwConfirm((v) => !v)}
            errorIfMismatch={pw !== pwConfirm && pwConfirm.length > 0}
          />
        </div>
        <footer className="set-modal__foot">
          <button type="button" className="set-modal__cancel" onClick={onClose}>취소</button>
          <button type="button" className="set-modal__ok" onClick={handleSubmit} disabled={!valid}>확인</button>
        </footer>
      </div>
    </div>
  );
}

function PasswordField({
  label, required, value, onChange, show, onToggleShow, errorIfMismatch,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  errorIfMismatch?: boolean;
}) {
  return (
    <div className="set-modal__field">
      <label>
        {label}
        {required && <em> *</em>}
      </label>
      <div className={'set-modal__pw' + (errorIfMismatch ? ' is-error' : '')}>
        <input
          type={show ? 'text' : 'password'}
          placeholder="비밀번호를 입력하세요"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" onClick={onToggleShow} aria-label="비밀번호 보기 토글">
          {show ? '🙈' : '👁'}
        </button>
      </div>
      {errorIfMismatch && <p className="set-modal__err">비밀번호가 일치하지 않습니다.</p>}
    </div>
  );
}

/* ───────── ④ 회사 정보 ───────── */

interface CompanyInfo {
  code: string;
  groupCode: string;
  name: string;
  bizNo: string;
  ceoName: string;
  postalCode: string;
  address: string;
  addressDetail: string;
  email: string;
  phone: string;
  fax: string;
  createdAt: string;
}

const COMPANY_KEY = 'ilgampack_admin:company';

function loadCompany(): CompanyInfo {
  try {
    const raw = localStorage.getItem(COMPANY_KEY);
    if (raw) return JSON.parse(raw) as CompanyInfo;
  } catch { /* ignore */ }
  return {
    code: '26400002',
    groupCode: 'G3',
    name: 'BODA_G3',
    bizNo: '123456780',
    ceoName: 'BODA_G3_CHIEF',
    postalCode: '012345',
    address: '성수',
    addressDetail: '2동',
    email: 'boda_g3@gmail.com',
    phone: '01012345678',
    fax: '0212345678',
    createdAt: '',
  };
}
function saveCompany(c: CompanyInfo) {
  try { localStorage.setItem(COMPANY_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

function CompanyInfoPanel() {
  const [info, setInfo] = useState<CompanyInfo>(() => loadCompany());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CompanyInfo>(info);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setDraft(info);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setError(null);
  }
  function save() {
    setError(null);
    if (!draft.name.trim() || !draft.bizNo.trim()) {
      setError('회사명, 사업자번호는 필수 입력입니다.');
      return;
    }
    const next: CompanyInfo = {
      ...draft,
      createdAt: draft.createdAt || new Date().toISOString().slice(0, 10),
    };
    setInfo(next);
    saveCompany(next);
    setEditing(false);
    window.alert('회사 정보가 저장되었습니다.');
  }

  function set<K extends keyof CompanyInfo>(k: K, v: CompanyInfo[K]) {
    setDraft((p) => ({ ...p, [k]: v }));
  }

  const v = editing ? draft : info;

  return (
    <section className="set-card">
      <header className="set-card__head">
        <div className="set-card__head-left">
          <h3>회사정보 관리</h3>
          <p>일당백에 등록된 회사 기본 정보입니다.</p>
        </div>
        <div className="set-card__head-right">
          {!editing ? (
            <button type="button" className="set-card__btn set-card__btn--edit" onClick={startEdit}>수정</button>
          ) : (
            <>
              <button type="button" className="set-card__btn set-card__btn--primary" onClick={save}>저장</button>
              <button type="button" className="set-card__btn" onClick={cancel}>취소</button>
            </>
          )}
        </div>
      </header>

      {error && <div className="set-card__error">{error}</div>}

      <div className="co-form">
        <section className="co-section">
          <h4 className="co-section__title">기본 정보</h4>
          <div className="co-section__body">
            <CoField label="회사코드"     value={v.code}      readOnly={!editing} onChange={(x) => set('code', x)} />
            <CoField label="회사그룹구분" value={v.groupCode} readOnly={!editing} onChange={(x) => set('groupCode', x)} />
            <CoField label="회사명"       value={v.name}      readOnly={!editing} onChange={(x) => set('name', x)} required />
            <CoField label="사업자번호"   value={v.bizNo}     readOnly={!editing} onChange={(x) => set('bizNo', x)} required />
            <CoField label="대표자명"     value={v.ceoName}   readOnly={!editing} onChange={(x) => set('ceoName', x)} />
          </div>
        </section>

        <section className="co-section">
          <h4 className="co-section__title">주소</h4>
          <div className="co-section__body">
            <div className="co-field co-field--wide">
              <label className="co-field__label">회사주소</label>
              <div className="co-field__value">
                <AddressField
                  value={v.address}
                  zonecode={v.postalCode}
                  showZonecode
                  onSelect={(d) => {
                    set('address', d.address);
                    set('postalCode', d.zonecode);
                  }}
                  onChange={(x) => set('address', x)}
                  readOnly={!editing}
                />
              </div>
            </div>
            <CoField label="회사주소상세" value={v.addressDetail} readOnly={!editing} onChange={(x) => set('addressDetail', x)} wide />
          </div>
        </section>

        <section className="co-section">
          <h4 className="co-section__title">연락처</h4>
          <div className="co-section__body">
            <CoField label="이메일"   value={v.email} readOnly={!editing} onChange={(x) => set('email', x)} type="email" />
            <CoField label="전화번호" value={v.phone} readOnly={!editing} onChange={(x) => set('phone', x)} type="tel" />
            <CoField label="팩스번호" value={v.fax}   readOnly={!editing} onChange={(x) => set('fax', x)} type="tel" />
            <CoField label="생성일시" value={v.createdAt} readOnly disabled />
          </div>
        </section>
      </div>
    </section>
  );
}

function CoField({
  label,
  value,
  onChange,
  readOnly,
  required,
  disabled,
  type = 'text',
  wide,
  full,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  wide?: boolean;
  full?: boolean;
}) {
  const cls =
    'co-field' +
    (disabled ? ' is-disabled' : '') +
    (wide ? ' co-field--wide' : '') +
    (full ? ' co-field--full' : '');
  const isPhone = type === 'tel' || type === 'phone';
  // 표시 모드(readOnly/disabled)는 자동 하이픈 포맷,
  // 편집 모드는 PhoneInput 으로 입력 즉시 하이픈 적용
  const displayedValue = isPhone && (readOnly || disabled) ? formatPhone(value) : value;
  return (
    <label className={cls}>
      <span className="co-field__label">
        {label}
        {required && <em className="co-field__req">*</em>}
      </span>
      {isPhone && !readOnly && !disabled ? (
        <PhoneInput
          value={value}
          onChange={(v) => onChange?.(v)}
          className="co-field__input"
        />
      ) : (
        <input
          type={type === 'tel' || type === 'phone' ? 'text' : type}
          value={displayedValue}
          readOnly={readOnly || disabled}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          className="co-field__input"
        />
      )}
    </label>
  );
}

/* ───────── 권한 요약 헬퍼 ───────── */
function summarizePerm(perm: AccountPermissions): {
  full: string[];
  read: string[];
  restrict: string[];
} {
  const out = { full: [] as string[], read: [] as string[], restrict: [] as string[] };
  for (const [k, v] of Object.entries(perm.menus)) {
    const label = PERM_LABELS[k] ?? k;
    if (v === '전체기능이용') out.full.push(label);
    else if (v === '조회') out.read.push(label);
    else if (v === '이용제한') out.restrict.push(label);
  }
  return out;
}

/* ───────── 권한 요약 칩 (hover / click → 메뉴 라벨 목록) ───────── */
function PermPill({
  level,
  labels,
  count,
}: {
  level: PermissionLevel;
  labels: string[];
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const cls =
    'perm-pill perm-pill--' +
    (level === '전체기능이용' ? 'full' : level === '조회' ? 'read' : 'restrict') +
    ' perm-pill--clickable' +
    (open ? ' is-open' : '');
  const shortLabel = level === '전체기능이용' ? '전체' : level === '조회' ? '조회' : '제한';

  return (
    <span
      ref={ref}
      className={cls}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      tabIndex={0}
    >
      {shortLabel} {count}
      <span className="perm-pill__pop" role="tooltip">
        <span className="perm-pill__pop-head">
          {level} · {count}개
        </span>
        {labels.length === 0 ? (
          <span className="perm-pill__pop-empty">해당 메뉴 없음</span>
        ) : (
          <span className="perm-pill__pop-list">
            {labels.map((l) => (
              <span key={l} className="perm-pill__pop-item">{l}</span>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
