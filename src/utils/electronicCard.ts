/**
 * electronicCard — 건설근로자공제회 전자카드 태그 이력 ↔ 얼굴인식 출역 비교
 *
 * 흐름
 *  1) 사용자가 공제회/김반장에서 다운로드한 전자카드 태그 이력 .xlsx 를 업로드
 *  2) 워크북에서 (성명, 일자, 출근시각, 퇴근시각) 행을 추출
 *  3) 우리 시스템의 얼굴인식 출역(AttendanceMonth)과 (성명+생년월일) 또는 (성명) 으로 매칭
 *  4) 같은 (워커, 일자) 튜플에 대해 다음 분류로 비교 결과 생성
 *
 *  분류 (DiffStatus)
 *    · OK            : 양쪽 모두 기록 있음, 출/퇴근 시각이 30분 이내로 일치
 *    · TIME_DIFF     : 양쪽 모두 기록 있으나 시각이 30분 이상 어긋남
 *    · CARD_ONLY     : 전자카드 태그만 있고 얼굴인식 출역이 없음
 *    · FACE_ONLY     : 얼굴인식 출역만 있고 전자카드 태그가 없음
 *    · UNMATCHED     : 전자카드 태그의 성명이 우리 시스템 워커 명단에 없음
 */

import * as XLSX from 'xlsx';
import type { AttendanceMonth } from '../api/attendance.types';
import type { TeamMember } from '../api/team.types';

/* ─────────── 도메인 ─────────── */

export type DiffStatus =
  | 'OK'
  | 'TIME_DIFF'
  | 'CARD_ONLY'
  | 'FACE_ONLY'
  | 'UNMATCHED';

/** 전자카드 태그 한 건 — 우리가 파싱한 단순화 형태 */
export interface ECardTag {
  date: string;            // 'YYYY-MM-DD'
  name: string;            // 성명
  /** 주민번호 앞 6자리(YYMMDD) 추출이 가능했으면 채워둠 */
  birth6?: string;
  /** 'HH:mm' 또는 빈 문자열 */
  inTime: string;
  outTime: string;
  /** 카드번호 또는 단말기명 (감사 로그용) */
  cardNo?: string;
  /** 원본 행 번호 — 디버그용 */
  rowIndex?: number;
}

/** 전자카드 .xlsx 파싱 결과 */
export interface ECardSheet {
  fileName: string;
  /** 시트에서 추정한 현장명 (있으면) */
  siteNameGuess?: string;
  /** 시트에서 추정한 신고월 'YYYY-MM' (있으면) */
  yearMonthGuess?: string;
  tags: ECardTag[];
  /** 파싱 시 인식하지 못한 행 수 */
  skippedRows: number;
}

/** 비교 결과 한 행 — (워커, 일자) 페어 */
export interface DiffRow {
  date: string;
  workerId?: string;       // 매칭된 우리 시스템 멤버 ID (UNMATCHED 면 비어 있음)
  name: string;            // 표시 이름 (전자카드 우선)
  status: DiffStatus;
  /** 차이(분) — TIME_DIFF 일 때 max(|in 차|, |out 차|) */
  diffMinutes?: number;
  card: { inTime: string; outTime: string; cardNo?: string } | null;
  face: { inTime: string; outTime: string; method?: string } | null;
  /** 사람이 읽을 수 있는 한 줄 설명 */
  reason: string;
}

/** 통계 요약 */
export interface DiffSummary {
  totalCardTags: number;
  totalFaceRecords: number;
  matched: number;        // OK
  timeDiff: number;
  cardOnly: number;
  faceOnly: number;
  unmatched: number;
  /** 일치율 (%) — matched / (matched + timeDiff + cardOnly + faceOnly) */
  matchRate: number;
}

/* ─────────── 1. 파서 ─────────── */

/**
 * 시트의 첫 N행을 살펴서 컬럼 인덱스를 추정.
 * 공제회/김반장 export 변형이 많아 헤더 키워드 매칭으로 동적 결정.
 */
interface ColMap {
  date: number;
  name: number;
  birth?: number;
  inTime: number;
  outTime: number;
  card?: number;
}

const HEADER_KEYS: Record<keyof ColMap, string[]> = {
  date:    ['일자', '날짜', '근무일', '작업일', 'date'],
  name:    ['성명', '이름', '근로자명', 'name'],
  birth:   ['주민', '생년', '주민번호', '주민등록번호'],
  inTime:  ['출근', '입장', '출근태그', '출근시각', 'in'],
  outTime: ['퇴근', '퇴장', '퇴근태그', '퇴근시각', 'out'],
  card:    ['카드', '단말', '카드번호', '단말기'],
};

function findHeaderRow(rows: any[][]): { row: number; cols: ColMap } | null {
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const row = rows[r] ?? [];
    const findCol = (keys: string[]) =>
      row.findIndex((cell) =>
        cell != null && keys.some((k) => String(cell).replace(/\s/g, '').includes(k.replace(/\s/g, '')))
      );
    const date = findCol(HEADER_KEYS.date);
    const name = findCol(HEADER_KEYS.name);
    const inTime = findCol(HEADER_KEYS.inTime);
    const outTime = findCol(HEADER_KEYS.outTime);
    if (date >= 0 && name >= 0 && inTime >= 0 && outTime >= 0) {
      return {
        row: r,
        cols: {
          date, name, inTime, outTime,
          birth: findCol(HEADER_KEYS.birth) >= 0 ? findCol(HEADER_KEYS.birth) : undefined,
          card:  findCol(HEADER_KEYS.card)  >= 0 ? findCol(HEADER_KEYS.card)  : undefined,
        },
      };
    }
  }
  return null;
}

function normalizeDate(raw: any): string {
  if (raw == null || raw === '') return '';
  // 엑셀 시리얼 번호일 수 있음
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d && d.y && d.m && d.d) {
      return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
  }
  const s = String(raw).trim();
  // 'YYYY-MM-DD'
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // 'YY/MM/DD' 또는 'YY.MM.DD'
  m = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return `20${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

function normalizeTime(raw: any): string {
  if (raw == null || raw === '') return '';
  // 엑셀 시간 시리얼 (소수점) — 예: 0.354 → 08:30
  if (typeof raw === 'number') {
    const totalMin = Math.round(raw * 24 * 60) % (24 * 60);
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  // 'HH:mm' 또는 'HH:mm:ss' 또는 'YYYY-MM-DD HH:mm:ss'
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return '';
}

function extractBirth6(raw: any): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).replace(/[^0-9]/g, '');
  if (s.length >= 6) return s.slice(0, 6);
  return undefined;
}

/**
 * 전자카드 .xlsx 파일을 읽어 ECardSheet 형태로 반환.
 * 헤더 행을 자동 탐지하므로 공제회/김반장 양쪽 export 모두 처리 가능.
 */
export async function parseElectronicCardFile(file: File): Promise<ECardSheet> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });

  // 시트 상단(헤더 위쪽)에서 현장명/연월 추정
  let siteNameGuess: string | undefined;
  let yearMonthGuess: string | undefined;
  for (let r = 0; r < Math.min(rows.length, 6); r++) {
    const flat = (rows[r] ?? []).map((c) => String(c ?? '')).join(' ');
    if (!siteNameGuess) {
      const m = flat.match(/현장(?:명)?\s*[:：]?\s*([^\s]+(?:\s+[^\s]+){0,3})/);
      if (m) siteNameGuess = m[1].trim();
    }
    if (!yearMonthGuess) {
      const m = flat.match(/(20\d{2})[-./년]\s*(\d{1,2})/);
      if (m) yearMonthGuess = `${m[1]}-${m[2].padStart(2, '0')}`;
    }
  }

  const found = findHeaderRow(rows);
  if (!found) {
    return {
      fileName: file.name,
      siteNameGuess,
      yearMonthGuess,
      tags: [],
      skippedRows: rows.length,
    };
  }

  const { row: headerRow, cols } = found;
  const tags: ECardTag[] = [];
  let skipped = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const date = normalizeDate(row[cols.date]);
    const name = String(row[cols.name] ?? '').trim();
    if (!date || !name) { skipped++; continue; }
    tags.push({
      date,
      name,
      birth6: cols.birth != null ? extractBirth6(row[cols.birth]) : undefined,
      inTime: normalizeTime(row[cols.inTime]),
      outTime: normalizeTime(row[cols.outTime]),
      cardNo: cols.card != null ? String(row[cols.card] ?? '').trim() || undefined : undefined,
      rowIndex: r + 1,
    });
  }

  // 파일에서 연월 추정이 안 됐으면 첫 태그의 연월로 보정
  if (!yearMonthGuess && tags.length > 0) {
    yearMonthGuess = tags[0].date.slice(0, 7);
  }

  return {
    fileName: file.name,
    siteNameGuess,
    yearMonthGuess,
    tags,
    skippedRows: skipped,
  };
}

/* ─────────── 2. 매칭 ─────────── */

/**
 * 우리 시스템 멤버 목록과 전자카드 태그를 매칭한다.
 *  · 1차: 성명 + 주민번호 앞 6자리 (있으면)
 *  · 2차: 성명만 (동명이인이 1명일 때만 인정)
 *  · 매칭 실패 시 workerId 비어 있는 채로 반환 (UNMATCHED 후보)
 */
function matchTagToMember(tag: ECardTag, members: TeamMember[]): TeamMember | null {
  const sameName = members.filter((m) => m.name.replace(/\s/g, '') === tag.name.replace(/\s/g, ''));
  if (sameName.length === 0) return null;
  if (tag.birth6) {
    // idNumberMasked 가 'YYMMDD-1******' 형식
    const byBirth = sameName.find((m) =>
      (m.idNumberRaw ?? m.idNumberMasked ?? '').replace(/[^0-9]/g, '').startsWith(tag.birth6!),
    );
    if (byBirth) return byBirth;
  }
  if (sameName.length === 1) return sameName[0];
  // 동명이인이 여러 명인데 생년월일 매칭 실패 → 매칭 불가
  return null;
}

/* ─────────── 3. 비교 엔진 ─────────── */

const TIME_TOLERANCE_MIN = 30;

function timeToMin(t: string): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function diffMin(a: string, b: string): number | null {
  const aa = timeToMin(a);
  const bb = timeToMin(b);
  if (aa == null || bb == null) return null;
  return Math.abs(aa - bb);
}

/** ISO -> 'HH:mm' (한국시간 가정) */
function isoToHm(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 전자카드 시트와 우리 AttendanceMonth 를 비교해 DiffRow[] 를 만든다.
 */
export function compareECardWithAttendance(opts: {
  sheet: ECardSheet;
  attendance: AttendanceMonth;
  members: TeamMember[];
}): { rows: DiffRow[]; summary: DiffSummary } {
  const { sheet, attendance, members } = opts;

  // (memberId|date) -> face record
  const faceMap = new Map<string, { inTime: string; outTime: string; method?: string; memberName: string }>();
  for (const memRow of attendance.rows) {
    for (const date of attendance.dates) {
      const rec = memRow.daily[date];
      if (!rec || rec.status === 'ABSENT') continue;
      faceMap.set(`${memRow.memberId}|${date}`, {
        inTime: isoToHm(rec.checkInAt),
        outTime: isoToHm(rec.checkOutAt),
        method: rec.checkInMethod ?? undefined,
        memberName: memRow.memberName,
      });
    }
  }

  // 카드 태그를 (memberId|date) 키로 정리. 매칭 실패한 것은 UNMATCHED 로 따로 보관.
  const cardMap = new Map<string, ECardTag & { memberId: string; memberName: string }>();
  const unmatchedTags: ECardTag[] = [];

  for (const tag of sheet.tags) {
    const m = matchTagToMember(tag, members);
    if (!m) { unmatchedTags.push(tag); continue; }
    const key = `${m.id}|${tag.date}`;
    // 같은 (워커,일자)에 카드 태그가 두 번 들어오는 경우 — 첫 태그의 in / 마지막 태그의 out 사용
    const prev = cardMap.get(key);
    if (prev) {
      cardMap.set(key, {
        ...prev,
        inTime: prev.inTime || tag.inTime,
        outTime: tag.outTime || prev.outTime,
      });
    } else {
      cardMap.set(key, { ...tag, memberId: m.id, memberName: m.name });
    }
  }

  const rows: DiffRow[] = [];

  // 카드 ↔ 얼굴 모두 있는 키와 한쪽만 있는 키
  const allKeys = new Set<string>([...cardMap.keys(), ...faceMap.keys()]);
  for (const key of allKeys) {
    const card = cardMap.get(key);
    const face = faceMap.get(key);
    const [memberId, date] = key.split('|');
    const name = card?.memberName ?? face?.memberName ?? '(이름 미상)';

    if (card && face) {
      const dIn  = diffMin(card.inTime, face.inTime);
      const dOut = diffMin(card.outTime, face.outTime);
      const maxDiff = Math.max(dIn ?? 0, dOut ?? 0);
      if (maxDiff <= TIME_TOLERANCE_MIN) {
        rows.push({
          date, workerId: memberId, name, status: 'OK',
          card: { inTime: card.inTime, outTime: card.outTime, cardNo: card.cardNo },
          face: { inTime: face.inTime, outTime: face.outTime, method: face.method },
          reason: '전자카드와 얼굴인식 시각이 일치합니다.',
        });
      } else {
        rows.push({
          date, workerId: memberId, name, status: 'TIME_DIFF',
          diffMinutes: maxDiff,
          card: { inTime: card.inTime, outTime: card.outTime, cardNo: card.cardNo },
          face: { inTime: face.inTime, outTime: face.outTime, method: face.method },
          reason: `시각 차이 ${maxDiff}분 (출근 ${dIn ?? '-'} / 퇴근 ${dOut ?? '-'})`,
        });
      }
    } else if (card && !face) {
      rows.push({
        date, workerId: memberId, name, status: 'CARD_ONLY',
        card: { inTime: card.inTime, outTime: card.outTime, cardNo: card.cardNo },
        face: null,
        reason: '전자카드 태그만 있음 — 얼굴인식 출역 누락',
      });
    } else if (!card && face) {
      rows.push({
        date, workerId: memberId, name, status: 'FACE_ONLY',
        card: null,
        face: { inTime: face.inTime, outTime: face.outTime, method: face.method },
        reason: '얼굴인식 출역만 있음 — 전자카드 태그 누락',
      });
    }
  }

  // 매칭 실패한 카드 태그 → UNMATCHED 행으로 추가
  for (const tag of unmatchedTags) {
    rows.push({
      date: tag.date,
      name: tag.name,
      status: 'UNMATCHED',
      card: { inTime: tag.inTime, outTime: tag.outTime, cardNo: tag.cardNo },
      face: null,
      reason: '시스템 미등록 근로자 — 워커 마스터에서 확인 필요',
    });
  }

  // 정렬: 일자 → 상태 우선순위(이상치 먼저) → 이름
  const order: Record<DiffStatus, number> = {
    UNMATCHED: 0, CARD_ONLY: 1, FACE_ONLY: 2, TIME_DIFF: 3, OK: 4,
  };
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return a.name.localeCompare(b.name, 'ko');
  });

  // 요약
  const matched = rows.filter((r) => r.status === 'OK').length;
  const timeDiff = rows.filter((r) => r.status === 'TIME_DIFF').length;
  const cardOnly = rows.filter((r) => r.status === 'CARD_ONLY').length;
  const faceOnly = rows.filter((r) => r.status === 'FACE_ONLY').length;
  const unmatched = rows.filter((r) => r.status === 'UNMATCHED').length;
  const denom = matched + timeDiff + cardOnly + faceOnly;
  const matchRate = denom > 0 ? Math.round((matched / denom) * 1000) / 10 : 0;

  return {
    rows,
    summary: {
      totalCardTags: sheet.tags.length,
      totalFaceRecords: faceMap.size,
      matched, timeDiff, cardOnly, faceOnly, unmatched,
      matchRate,
    },
  };
}

/* ─────────── 4. Excel 다운로드 ─────────── */

const STATUS_LABEL: Record<DiffStatus, string> = {
  OK: '일치',
  TIME_DIFF: '시각 차이',
  CARD_ONLY: '카드만',
  FACE_ONLY: '얼굴만',
  UNMATCHED: '미등록 근로자',
};

export function exportDiffToXlsx(rows: DiffRow[], summary: DiffSummary, opts: { siteName?: string; yearMonth?: string }): Blob {
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryRows = [
    ['보다패스 — 전자카드 ↔ 얼굴인식 출역 비교'],
    ['현장', opts.siteName ?? ''],
    ['신고월', opts.yearMonth ?? ''],
    ['생성일시', new Date().toLocaleString('ko-KR')],
    [],
    ['전자카드 태그 총 건수', summary.totalCardTags],
    ['얼굴인식 출역 총 건수', summary.totalFaceRecords],
    ['일치', summary.matched],
    ['시각 차이', summary.timeDiff],
    ['카드만 (얼굴 누락)', summary.cardOnly],
    ['얼굴만 (카드 누락)', summary.faceOnly],
    ['미등록 근로자', summary.unmatched],
    ['일치율(%)', summary.matchRate],
  ];
  const sumWs = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, sumWs, '요약');

  // Detail sheet
  const detailHeader = [
    '일자', '성명', '상태', '카드출근', '카드퇴근', '얼굴출근', '얼굴퇴근',
    '시각차이(분)', '카드번호', '인증방법', '비고',
  ];
  const detailRows = rows.map((r) => [
    r.date, r.name, STATUS_LABEL[r.status],
    r.card?.inTime ?? '', r.card?.outTime ?? '',
    r.face?.inTime ?? '', r.face?.outTime ?? '',
    r.diffMinutes ?? '',
    r.card?.cardNo ?? '',
    r.face?.method ?? '',
    r.reason,
  ]);
  const detailWs = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
  XLSX.utils.book_append_sheet(wb, detailWs, '상세');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export const STATUS_LABELS = STATUS_LABEL;
