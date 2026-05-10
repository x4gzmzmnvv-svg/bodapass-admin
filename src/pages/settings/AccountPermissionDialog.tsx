import { useEffect, useState } from 'react';
import { siteApi } from '../../api/site';
import type { Site } from '../../api/site.types';
import './AccountPermissionDialog.css';

import { MacSelect } from '../../components/MacSelect';
/* ─────────────── 권한 레벨 ─────────────── */

export type PermissionLevel = '조회' | '전체기능이용' | '이용제한';

const LEVELS: PermissionLevel[] = ['조회', '전체기능이용', '이용제한'];

/* ─────────────── 우리 앱 메뉴 — 4개 그룹으로 분류 ─────────────── */

interface PermItem {
  key: string;
  label: string;
}

interface PermGroup {
  title: string;
  items: PermItem[];
}

const PERM_GROUPS: PermGroup[] = [
  {
    title: '메인 메뉴',
    items: [
      { key: 'dashboard',  label: '대시보드' },
      { key: 'team',       label: '팀원 관리' },
      { key: 'site',       label: '현장 관리' },
      { key: 'attendance', label: '출퇴근 현황' },
      { key: 'wage',       label: '임금/노임비' },
      { key: 'reports',    label: '통계/리포트' },
    ],
  },
  {
    title: '임금 관련 발행',
    items: [
      { key: 'wageLedger',   label: '노임대장 발행/업로드' },
      { key: 'paySlip',      label: '임금명세서 발행' },
      { key: 'laborReport',  label: '근로내용확인신고서' },
    ],
  },
  {
    title: '알림 발송',
    items: [
      { key: 'contractSend', label: '계약 송부 (반장)' },
      { key: 'safetyAlert',  label: '안전 알림 (산업안전 경보)' },
      { key: 'wagePush',     label: '임금명세서 알림톡 발송' },
    ],
  },
  {
    title: '시스템',
    items: [
      { key: 'settingsAttendance', label: '설정 — 출퇴근시간' },
      { key: 'settingsTax',        label: '설정 — 세율' },
      { key: 'settingsCompany',    label: '설정 — 회사 정보' },
      { key: 'accountManage',      label: '계정 관리' },
    ],
  },
];

const ALL_KEYS = PERM_GROUPS.flatMap((g) => g.items.map((it) => it.key));

/** 메뉴 키 → 한글 라벨 맵 (테이블/요약 칩에서 사용) */
export const PERM_LABELS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const g of PERM_GROUPS) for (const it of g.items) m[it.key] = it.label;
  return m;
})();

/* ─────────────── 권한 데이터 모양 ─────────────── */

export interface AccountPermissions {
  /** 'ALL' = 전체현장 / siteId 문자열 = 단일 현장 */
  scope: 'ALL' | string;
  /** 메뉴별 권한 */
  menus: Record<string, PermissionLevel>;
}

export function defaultPermissions(): AccountPermissions {
  const menus: Record<string, PermissionLevel> = {};
  for (const k of ALL_KEYS) menus[k] = '조회';
  // 합리적 기본값 — 본사 현장담당자 가정
  menus.dashboard = '전체기능이용';
  menus.team = '전체기능이용';
  menus.site = '전체기능이용';
  menus.attendance = '전체기능이용';
  menus.wage = '전체기능이용';
  menus.accountManage = '이용제한';
  menus.settingsCompany = '이용제한';
  return { scope: 'ALL', menus };
}

/* ─────────────── 다이얼로그 ─────────────── */

interface Props {
  accountName: string;
  accountId: string;
  initial: AccountPermissions;
  onClose: () => void;
  onSave: (perm: AccountPermissions) => void;
}

export function AccountPermissionDialog({
  accountName,
  accountId,
  initial,
  onClose,
  onSave,
}: Props) {
  const [perm, setPerm] = useState<AccountPermissions>(initial);
  const [sites, setSites] = useState<Site[]>([]);

  useEffect(() => {
    siteApi.listSites().then((r) => setSites(r.sites)).catch(() => {});
  }, []);

  function setMenu(k: string, v: PermissionLevel) {
    setPerm((p) => ({ ...p, menus: { ...p.menus, [k]: v } }));
  }

  function applyAll(level: PermissionLevel) {
    const next: Record<string, PermissionLevel> = {};
    for (const k of ALL_KEYS) next[k] = level;
    setPerm((p) => ({ ...p, menus: next }));
  }

  return (
    <div
      className="perm-modal__backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="perm-modal">
        <header className="perm-modal__head">
          <div>
            <h3>사용 권한 설정</h3>
            <p className="perm-modal__sub">
              <strong>{accountName}</strong> ({accountId}) 의 메뉴별 접근 권한을 설정합니다.
            </p>
          </div>
          <button type="button" className="perm-modal__x" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>

        <div className="perm-modal__body">
          {/* 현장 배정 */}
          <section className="perm-section">
            <h4 className="perm-section__title">현장 배정</h4>
            <div className="perm-section__body perm-section__body--row">
              <span className="perm-row__lbl" style={{ flex: '0 0 auto', fontWeight: 700 }}>
                접근 현장
              </span>
              <MacSelect
              value={perm.scope}
              onChange={(v) => setPerm((p) => ({ ...p, scope: v }))}
              options={[{ value: "ALL", label: '전체 현장 (본사 사용자)' }, ...sites.map((s) => (
                  ({ value: s.id, label: s.name })
                ))]}
            />
              <span className="perm-section__hint perm-section__hint--info" style={{ margin: 0 }}>
                전체 현장 = 본사 / 단일 현장 = 현장 담당자
              </span>
            </div>
          </section>

          {/* 일괄 적용 */}
          <section className="perm-bulk">
            <span className="perm-bulk__lbl">전체 일괄 적용</span>
            {LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                className={'perm-bulk__btn perm-bulk__btn--' + levelClass(lv)}
                onClick={() => applyAll(lv)}
              >
                {lv}
              </button>
            ))}
          </section>

          {/* 그룹별 메뉴 권한 */}
          {PERM_GROUPS.map((g) => (
            <section key={g.title} className="perm-section">
              <h4 className="perm-section__title">{g.title}</h4>
              <div className="perm-section__body perm-grid">
                {g.items.map((it) => (
                  <div key={it.key} className="perm-row">
                    <span className="perm-row__lbl">{it.label}</span>
                    <MacSelect
              value={perm.menus[it.key] ?? '조회'}
              onChange={(v) => setMenu(it.key, v as PermissionLevel)}
              className={'perm-select perm-select--' + levelClass(perm.menus[it.key] ?? '조회')}
              options={[...LEVELS.map((lv) => (
                        ({ value: lv, label: lv })
                      ))]}
            />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="perm-modal__foot">
          <button type="button" className="perm-btn perm-btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="perm-btn perm-btn--primary"
            onClick={() => onSave(perm)}
          >
            저장
          </button>
        </footer>
      </div>
    </div>
  );
}

function levelClass(lv: PermissionLevel): string {
  return lv === '전체기능이용' ? 'full' : lv === '조회' ? 'read' : 'restrict';
}
