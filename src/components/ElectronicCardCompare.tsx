/**
 * ElectronicCardCompare — 건설근로자공제회 전자카드 태그 ↔ 얼굴인식 출역 비교 (섹션)
 *
 * 퇴직공제 페이지에 임베드되는 서브 섹션. 페이지 wrapper 는 부모가 담당하며,
 * 이 컴포넌트는 안쪽 컨트롤 + 결과 표만 그린다.
 *
 *  · 사용자가 공제회/김반장에서 받은 전자카드 태그 이력 .xlsx 를 업로드
 *  · 부모가 넘겨준 siteId/yearMonth 로 우리 시스템 얼굴인식 출역(/attendance/month) 자동 로드
 *  · OK / 시각차이 / 카드만 / 얼굴만 / 미등록 5가지로 분류
 *  · 결과를 표 형태로 표시 + 비교 .xlsx 다운로드
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { teamApi } from '../api/team';
import { attendanceApi } from '../api/attendance';
import type { Site } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import type { AttendanceMonth } from '../api/attendance.types';
import {
  parseElectronicCardFile,
  compareECardWithAttendance,
  exportDiffToXlsx,
  STATUS_LABELS,
  type ECardSheet,
  type DiffRow,
  type DiffSummary,
  type DiffStatus,
} from '../utils/electronicCard';
import './ElectronicCardCompare.css';

const STATUS_ORDER: DiffStatus[] = ['UNMATCHED', 'CARD_ONLY', 'FACE_ONLY', 'TIME_DIFF', 'OK'];

const STATUS_COLOR: Record<DiffStatus, string> = {
  OK: '#34C759',
  TIME_DIFF: '#FF9500',
  CARD_ONLY: '#FF3B30',
  FACE_ONLY: '#FF3B30',
  UNMATCHED: '#8E8E93',
};

interface Props {
  /** 부모 페이지가 선택한 현장 — 없으면 비교 비활성화 */
  siteId: string | null;
  /** 부모 페이지가 선택한 신고월 (YYYY-MM) */
  yearMonth: string;
  /** 사이트 목록 — 다운로드 시 현장명 라벨용 */
  sites: Site[];
}

export function ElectronicCardCompare({ siteId, yearMonth, sites }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [attendance, setAttendance] = useState<AttendanceMonth | null>(null);
  const [loadingAtt, setLoadingAtt] = useState(false);

  const [sheet, setSheet] = useState<ECardSheet | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<DiffStatus>>(
    () => new Set<DiffStatus>(['UNMATCHED', 'CARD_ONLY', 'FACE_ONLY', 'TIME_DIFF']),
  );
  const fileRef = useRef<HTMLInputElement>(null);

  // 멤버 로드 (한 번만)
  useEffect(() => {
    let cancelled = false;
    teamApi
      .list()
      .then((res) => {
        if (!cancelled) setMembers(res.members ?? []);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // siteId/yearMonth 가 바뀌면 출역 자동 로드
  useEffect(() => {
    if (!siteId || !yearMonth) {
      setAttendance(null);
      return;
    }
    let cancelled = false;
    setLoadingAtt(true);
    attendanceApi
      .month({ siteId, yearMonth })
      .then((res) => {
        if (!cancelled) setAttendance(res);
      })
      .catch(() => {
        if (!cancelled) setAttendance(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingAtt(false);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, yearMonth]);

  // 비교 결과
  const compareResult = useMemo(() => {
    if (!sheet || !attendance) return null;
    return compareECardWithAttendance({ sheet, attendance, members });
  }, [sheet, attendance, members]);

  const filteredRows: DiffRow[] = useMemo(() => {
    if (!compareResult) return [];
    return compareResult.rows.filter((r) => statusFilter.has(r.status));
  }, [compareResult, statusFilter]);

  function toggleStatus(s: DiffStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  async function handleFile(file: File) {
    setParseError(null);
    try {
      const parsed = await parseElectronicCardFile(file);
      if (parsed.tags.length === 0) {
        setParseError(
          '태그 행을 인식하지 못했어요. 헤더에 「일자/성명/출근/퇴근」이 포함된 시트인지 확인해 주세요.',
        );
      }
      setSheet(parsed);
    } catch (e: any) {
      setParseError(e?.message ?? '파일을 읽는 중 오류가 발생했습니다.');
      setSheet(null);
    }
  }

  function handleDownload() {
    if (!compareResult) return;
    const site = sites.find((s) => s.id === siteId);
    const blob = exportDiffToXlsx(compareResult.rows, compareResult.summary, {
      siteName: site?.name,
      yearMonth,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `전자카드비교_${site?.name ?? siteId ?? 'site'}_${yearMonth}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="ecard card">
      <div className="ecard__head">
        <div>
          <h3 className="ecard__title">전자카드 ↔ 얼굴인식 출역 비교</h3>
          <p className="ecard__subtitle">
            건설근로자공제회 전자카드 단말기 태그 이력을 업로드하면, 위 퇴직공제 적립 산정 기준이
            되는 얼굴인식 출역과 자동 비교하여 누락·시각차이·미등록 근로자를 표시합니다.
          </p>
        </div>
        <button
          type="button"
          className="ecard__upload-btn"
          onClick={() => fileRef.current?.click()}
        >
          {sheet ? `📎 ${sheet.fileName}` : '전자카드 .xlsx 선택…'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {parseError && <div className="ecard__error">⚠ {parseError}</div>}

      {!sheet && (
        <div className="ecard__empty">
          <h4>📥 전자카드 태그 이력을 업로드하세요</h4>
          <p>
            건설근로자공제회 「전자카드제 출역기록」 또는 김반장에서 다운로드한 .xlsx 파일을
            우측 상단 「전자카드 .xlsx 선택」 버튼으로 올려주세요.
          </p>
          <p className="ecard__hint">
            파일은 다음 컬럼을 포함해야 합니다 — <strong>일자 · 성명 · 출근 · 퇴근</strong>
            (주민번호·카드번호 컬럼은 있으면 매칭 정확도가 올라갑니다).
          </p>
        </div>
      )}

      {sheet && (
        <SheetInfo
          sheet={sheet}
          attendance={attendance}
          loadingAtt={loadingAtt}
        />
      )}

      {compareResult && (
        <>
          <SummaryBar
            summary={compareResult.summary}
            statusFilter={statusFilter}
            onToggle={toggleStatus}
            onDownload={handleDownload}
          />
          <DiffTable rows={filteredRows} totalRows={compareResult.rows.length} />
        </>
      )}
    </section>
  );
}

/* ─────────── 하위 컴포넌트 ─────────── */

function SheetInfo({
  sheet, attendance, loadingAtt,
}: { sheet: ECardSheet; attendance: AttendanceMonth | null; loadingAtt: boolean }) {
  return (
    <div className="ecard__sheet-info">
      <div className="ecard__sheet-row">
        <span className="ecard__sheet-key">업로드 파일</span>
        <strong>{sheet.fileName}</strong>
      </div>
      <div className="ecard__sheet-row">
        <span className="ecard__sheet-key">전자카드 태그</span>
        <strong>{sheet.tags.length.toLocaleString()}건</strong>
        {sheet.skippedRows > 0 && (
          <span className="ecard__sheet-aside">· {sheet.skippedRows}행 스킵</span>
        )}
      </div>
      {sheet.siteNameGuess && (
        <div className="ecard__sheet-row">
          <span className="ecard__sheet-key">파일 내 현장명</span>
          <strong>{sheet.siteNameGuess}</strong>
        </div>
      )}
      {sheet.yearMonthGuess && (
        <div className="ecard__sheet-row">
          <span className="ecard__sheet-key">파일 내 연월</span>
          <strong>{sheet.yearMonthGuess}</strong>
        </div>
      )}
      <div className="ecard__sheet-row">
        <span className="ecard__sheet-key">얼굴인식 출역</span>
        {loadingAtt
          ? <strong>불러오는 중…</strong>
          : <strong>{(attendance?.summary.faceCount ?? 0).toLocaleString()}건</strong>}
      </div>
    </div>
  );
}

function SummaryBar({
  summary, statusFilter, onToggle, onDownload,
}: {
  summary: DiffSummary;
  statusFilter: Set<DiffStatus>;
  onToggle: (s: DiffStatus) => void;
  onDownload: () => void;
}) {
  const counts: Record<DiffStatus, number> = {
    OK: summary.matched,
    TIME_DIFF: summary.timeDiff,
    CARD_ONLY: summary.cardOnly,
    FACE_ONLY: summary.faceOnly,
    UNMATCHED: summary.unmatched,
  };

  return (
    <div className="ecard__summary">
      <div className="ecard__summary-pills">
        {STATUS_ORDER.map((s) => {
          const active = statusFilter.has(s);
          return (
            <button
              key={s}
              type="button"
              className={'ecard__pill' + (active ? ' is-on' : '')}
              style={{ '--pill-color': STATUS_COLOR[s] } as React.CSSProperties}
              onClick={() => onToggle(s)}
              title={`${STATUS_LABELS[s]} 표시 ${active ? '끄기' : '켜기'}`}
            >
              <span className="ecard__pill-dot" />
              <span className="ecard__pill-label">{STATUS_LABELS[s]}</span>
              <span className="ecard__pill-count">{counts[s].toLocaleString()}</span>
            </button>
          );
        })}
      </div>
      <div className="ecard__summary-right">
        <div className="ecard__match-rate">
          <span className="ecard__match-rate-label">일치율</span>
          <strong className="ecard__match-rate-num">{summary.matchRate}%</strong>
        </div>
        <button type="button" className="ecard__download" onClick={onDownload}>
          📊 비교 결과 .xlsx 다운로드
        </button>
      </div>
    </div>
  );
}

function DiffTable({ rows, totalRows }: { rows: DiffRow[]; totalRows: number }) {
  if (totalRows === 0) {
    return (
      <div className="ecard__table-empty">
        비교할 데이터가 없습니다. 신고월 또는 사이트를 다시 확인해 주세요.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="ecard__table-empty">
        선택한 필터에 해당하는 행이 없습니다 (총 {totalRows}건 중 0건 표시).
      </div>
    );
  }

  return (
    <div className="ecard__table-wrap">
      <table className="ecard__table">
        <thead>
          <tr>
            <th>일자</th>
            <th>성명</th>
            <th>상태</th>
            <th>카드 출근/퇴근</th>
            <th>얼굴 출근/퇴근</th>
            <th>차이</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={'ecard__row ecard__row--' + r.status}>
              <td className="ecard__td-date">{r.date.slice(5)}</td>
              <td className="ecard__td-name">{r.name}</td>
              <td>
                <span
                  className="ecard__chip"
                  style={{ '--chip-color': STATUS_COLOR[r.status] } as React.CSSProperties}
                >
                  {STATUS_LABELS[r.status]}
                </span>
              </td>
              <td className="ecard__td-time">
                {r.card
                  ? <><span>{r.card.inTime || '—'}</span> · <span>{r.card.outTime || '—'}</span></>
                  : <span className="ecard__td-empty">—</span>}
              </td>
              <td className="ecard__td-time">
                {r.face
                  ? <><span>{r.face.inTime || '—'}</span> · <span>{r.face.outTime || '—'}</span></>
                  : <span className="ecard__td-empty">—</span>}
              </td>
              <td className="ecard__td-diff">
                {r.diffMinutes != null ? `${r.diffMinutes}분` : ''}
              </td>
              <td className="ecard__td-reason">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ecard__table-footer">
        총 {totalRows.toLocaleString()}건 중 {rows.length.toLocaleString()}건 표시
      </div>
    </div>
  );
}
