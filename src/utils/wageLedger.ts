/**
 * 노임대장 (일용노무비지급명세서) 처리 모듈
 *
 * 기능:
 * 1. 우리 임금 데이터로부터 노임대장 양식의 행 빌드
 * 2. 양식 템플릿 (public/templates/wage-ledger-template.xlsx)을 로드해 데이터를 채워서
 *    엑셀 파일로 다운로드
 * 3. 사용자가 업로드한 노임대장 .xlsx 파일을 파싱해 행 추출
 * 4. localStorage에 누적 보관 (관리자가 시간순으로 모든 노임대장 이력을 보관)
 */

import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import type { WageMonthSummary } from '../api/wage.types';
import type { Site } from '../api/site.types';

const TEMPLATE_URL = '/templates/wage-ledger-template.xlsx';
const STORAGE_KEY = 'bodapass_admin:wage_ledger_archive';

/* ────────────────── 도메인 모델 ────────────────── */

/** 노임대장 한 명에 해당하는 단순화 행 (우리 데이터에서 산출) */
export interface LedgerRow {
  order: number;            // 순서
  name: string;             // 성명
  idNumber: string;         // 주민등록번호 (마스킹)
  phone: string;            // 전화번호
  address: string;          // 주소
  trade: string;            // 공종 | 직종 | 팀
  /** 일자별 공수 (1~31일) — 0 = 결근 */
  dailyGongsu: number[];    // length 31
  totalGongsu: number;      // 총공수
  dailyWage: number;        // 노무비 단가
  totalWage: number;        // 노무비 총액
  bonus: number;            // 수당총액
  netPaid: number;          // 차감 지급액
  // 공제
  employmentInsurance: number;  // 고용보험
  incomeTax: number;            // 소득세
  healthInsurance: number;      // 건강보험
  netHealthInsurance: number;   // 순건강보험
  pensionExempt: 'YES' | 'NO';  // 연금적용제외
  firstWorkDate: string;        // 현장 최초 근로일
}

export interface LedgerDoc {
  /** 발행 식별자 (yyyy-mm-siteId-timestamp) */
  id: string;
  /** 회사명 */
  companyName: string;
  /** 발행 연월 (YYYY-MM) */
  yearMonth: string;
  /** 현장명 */
  siteName: string;
  /** 기간 시작일 ~ 종료일 (YYYY-MM-DD) */
  periodStart: string;
  periodEnd: string;
  /** 고용관리책임자 */
  manager: { name: string; idNumber: string };
  rows: LedgerRow[];
  /** 발행 / 업로드 시각 */
  createdAt: string;
  /** 'GENERATED' = 우리가 우리 데이터로 만든 것, 'UPLOADED' = 외부 파일 업로드 */
  source: 'GENERATED' | 'UPLOADED';
  /** 업로드 시 원본 파일명 */
  uploadedFileName?: string;
}

/* ────────── 1. 우리 데이터로부터 노임대장 빌드 ────────── */

/**
 * WageMonthSummary 한 달치 데이터로부터 LedgerDoc 만들기.
 * 일자별 공수는 일당과 총임금에서 역산 (1.0 공수 가정).
 */
export function buildLedgerFromWage(opts: {
  summary: WageMonthSummary;
  site: Site | null;
  companyName: string;
  managerName?: string;
}): LedgerDoc {
  const { summary, site, companyName, managerName } = opts;
  const yyyy = summary.year;
  const mm = summary.month;
  const lastDay = new Date(yyyy, mm, 0).getDate(); // 해당 월의 마지막 일자

  // 우리는 일자별 데이터를 직접 보관하지 않으므로 근무일을 등간격으로 분포
  const distributeWorkDays = (workDays: number): number[] => {
    const arr = new Array(31).fill(0);
    if (workDays <= 0) return arr;
    // 1일부터 lastDay 중에 workDays개를 균등 분포 (간단화)
    const step = lastDay / workDays;
    for (let i = 0; i < workDays; i++) {
      const day = Math.min(lastDay, Math.floor(i * step) + 1);
      arr[day - 1] = 1.0;
    }
    return arr;
  };

  const rows: LedgerRow[] = summary.rows.map((r, idx) => ({
    order: idx + 1,
    name: r.memberName,
    idNumber: r.idNumberMasked,
    phone: '',
    address: '',
    trade: `미지정 | ${r.role} | 직영`,
    dailyGongsu: distributeWorkDays(r.workDays),
    totalGongsu: r.workDays,
    dailyWage: r.dailyWage,
    totalWage: r.baseAmount,
    bonus: 0,
    netPaid: r.netAmount,
    employmentInsurance: r.deductionEmployment,
    incomeTax: r.deductionIncomeTax,
    healthInsurance: r.deductionHealth,
    netHealthInsurance: 0,
    pensionExempt: r.deductionPension > 0 ? 'NO' : 'YES',
    firstWorkDate: `${yyyy}-${String(mm).padStart(2, '0')}-01`,
  }));

  return {
    id: `LDG-${summary.year}-${String(summary.month).padStart(2, '0')}-${site?.id ?? 'ALL'}-${Date.now().toString(36)}`,
    companyName,
    yearMonth: `${yyyy}-${String(mm).padStart(2, '0')}`,
    siteName: site?.name ?? '전체 현장',
    periodStart: `${yyyy}-${String(mm).padStart(2, '0')}-01`,
    periodEnd: `${yyyy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    manager: { name: managerName ?? '', idNumber: '' },
    rows,
    createdAt: new Date().toISOString(),
    source: 'GENERATED',
  };
}

/* ────────── 2. 엑셀 다운로드 — 양식 보존 + 우리 데이터 채우기 ────────── */

/**
 * 양식 폴더의 노임대장 원본을 ExcelJS로 로드 → 셀병합·서식·수식 그대로 두고
 * 우리 데이터만 해당 셀에 채워 .xlsx로 다운로드.
 * (SheetJS 커뮤니티 버전이 스타일을 못 보존하므로 ExcelJS 사용)
 */
export async function downloadLedgerXlsx(doc: LedgerDoc): Promise<void> {
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error('양식 파일을 찾을 수 없습니다.');
  const buf = await res.arrayBuffer();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];

  // ── 헤더 정보 (1~2행) ──
  setVal(ws, 'B1', doc.companyName);
  const ymLabel = `일용노무비지급명세서(${doc.yearMonth.slice(2, 4)}년 ${doc.yearMonth.slice(5, 7)}월)`;
  setVal(ws, 'D1', ymLabel);
  setVal(ws, 'O1', formatYmd(doc.periodStart));
  setVal(ws, 'O2', formatYmd(doc.periodEnd));
  setVal(ws, 'V1', doc.siteName);
  setVal(ws, 'AB1', doc.manager.name);
  setVal(ws, 'AB2', doc.manager.idNumber);

  // ── 데이터 행 — 7행부터 시작, 한 사람당 2행 ──
  doc.rows.forEach((r, idx) => {
    const top = 7 + idx * 2;
    const bot = top + 1;
    if (top > 30) return; // 양식의 데이터 영역은 30행까지

    setVal(ws, `A${top}`, r.order);
    setVal(ws, `B${top}`, r.name);
    setVal(ws, `C${top}`, r.idNumber);
    setVal(ws, `D${top}`, r.address);

    setVal(ws, `C${bot}`, r.phone);
    setVal(ws, `D${bot}`, r.trade);

    // 1~15일 공수 (E~S 컬럼)
    for (let i = 0; i < 15; i++) {
      const v = r.dailyGongsu[i];
      if (v > 0) setVal(ws, `${colLetter(5 + i)}${top}`, v);
    }
    // 16~31일 공수
    for (let i = 0; i < 16; i++) {
      const v = r.dailyGongsu[15 + i];
      if (v > 0) setVal(ws, `${colLetter(5 + i)}${bot}`, v);
    }

    setVal(ws, `U${top}`, r.totalGongsu);
    setVal(ws, `V${top}`, r.dailyWage);
    setVal(ws, `W${top}`, r.totalWage);
    setVal(ws, `X${top}`, r.bonus);
    setVal(ws, `Y${top}`, r.netPaid);
    setVal(ws, `AA${top}`, r.employmentInsurance);
    setVal(ws, `AB${top}`, r.incomeTax);
    setVal(ws, `AC${top}`, r.healthInsurance);
    setVal(ws, `AD${top}`, r.netHealthInsurance);
    setVal(ws, `AE${top}`, r.pensionExempt);
    setVal(ws, `AL${top}`, r.firstWorkDate);
  });

  // ── 다운로드 ──
  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `노임대장_${doc.yearMonth}_${doc.siteName.replace(/\s/g, '_')}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * ExcelJS 셀에 값 안전하게 설정.
 * 셀의 기존 스타일·서식은 그대로 두고 .value만 갱신.
 */
function setVal(ws: ExcelJS.Worksheet, addr: string, value: string | number) {
  if (value === null || value === undefined || value === '') return;
  const cell = ws.getCell(addr);
  cell.value = value;
}

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function formatYmd(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y.slice(2)}년 ${m}월 ${d}일`;
}

/* ────────── 3. 업로드 파일 파싱 ────────── */

/**
 * 사용자가 업로드한 노임대장 .xlsx 파일을 파싱해 LedgerDoc 추출.
 * 양식과 동일한 구조라고 가정.
 */
export async function parseLedgerFile(file: File): Promise<LedgerDoc> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const companyName = String(getCell(ws, 'B1') ?? '');
  const titleRaw = String(getCell(ws, 'D1') ?? '');
  // "일용노무비지급명세서(26년 03월)" 에서 26년 03월 추출
  const ymMatch = titleRaw.match(/(\d{2})년\s*(\d{2})월/);
  const yearMonth = ymMatch
    ? `20${ymMatch[1]}-${ymMatch[2]}`
    : new Date().toISOString().slice(0, 7);

  const siteName = String(getCell(ws, 'V1') ?? '');
  const periodStart = parseYmdLabel(String(getCell(ws, 'O1') ?? ''), yearMonth, '01');
  const periodEnd = parseYmdLabel(String(getCell(ws, 'O2') ?? ''), yearMonth, '31');
  const managerName = String(getCell(ws, 'AB1') ?? '');
  const managerId = String(getCell(ws, 'AB2') ?? '');

  // 데이터 행 수집 — 7행부터 30행까지 (한 사람당 2행)
  const rows: LedgerRow[] = [];
  for (let top = 7; top <= 30; top += 2) {
    const order = getCell(ws, `A${top}`);
    const name = getCell(ws, `B${top}`);
    if (!name) continue; // 빈 슬롯 스킵
    const bot = top + 1;

    const dailyGongsu: number[] = new Array(31).fill(0);
    for (let i = 0; i < 15; i++) {
      const col = colLetter(5 + i);
      const v = Number(getCell(ws, `${col}${top}`)) || 0;
      dailyGongsu[i] = v;
    }
    for (let i = 0; i < 16; i++) {
      const col = colLetter(5 + i);
      const v = Number(getCell(ws, `${col}${bot}`)) || 0;
      dailyGongsu[15 + i] = v;
    }

    rows.push({
      order: Number(order) || rows.length + 1,
      name: String(name),
      idNumber: String(getCell(ws, `C${top}`) ?? ''),
      phone: String(getCell(ws, `C${bot}`) ?? ''),
      address: String(getCell(ws, `D${top}`) ?? ''),
      trade: String(getCell(ws, `D${bot}`) ?? ''),
      dailyGongsu,
      totalGongsu: Number(getCell(ws, `U${top}`)) || dailyGongsu.reduce((s, x) => s + x, 0),
      dailyWage: Number(getCell(ws, `V${top}`)) || 0,
      totalWage: Number(getCell(ws, `W${top}`)) || 0,
      bonus: Number(getCell(ws, `X${top}`)) || 0,
      netPaid: Number(getCell(ws, `Y${top}`)) || 0,
      employmentInsurance: Number(getCell(ws, `AA${top}`)) || 0,
      incomeTax: Number(getCell(ws, `AB${top}`)) || 0,
      healthInsurance: Number(getCell(ws, `AC${top}`)) || 0,
      netHealthInsurance: Number(getCell(ws, `AD${top}`)) || 0,
      pensionExempt: String(getCell(ws, `AE${top}`) ?? 'NO').toUpperCase().includes('Y')
        ? 'YES'
        : 'NO',
      firstWorkDate: String(getCell(ws, `AL${top}`) ?? ''),
    });
  }

  return {
    id: `LDG-${yearMonth}-UP-${Date.now().toString(36)}`,
    companyName,
    yearMonth,
    siteName,
    periodStart,
    periodEnd,
    manager: { name: managerName, idNumber: managerId },
    rows,
    createdAt: new Date().toISOString(),
    source: 'UPLOADED',
    uploadedFileName: file.name,
  };
}

function getCell(ws: XLSX.WorkSheet, addr: string): string | number | null {
  const cell = ws[addr];
  if (!cell) return null;
  return cell.v ?? null;
}

function parseYmdLabel(label: string, ym: string, fallbackDay: string): string {
  // "26년 03월 01일" → "2026-03-01"
  const m = label.match(/(\d{2})년\s*(\d{2})월\s*(\d{2})일/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  return `${ym}-${fallbackDay}`;
}

/* ────────── 4. localStorage 누적 저장소 ────────── */

export function getArchive(): LedgerDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as LedgerDoc[];
  } catch {
    return [];
  }
}

export function appendToArchive(doc: LedgerDoc): void {
  const list = getArchive();
  list.unshift(doc);
  // 최대 200개만 보관 (오래된 건 자동 삭제)
  const trimmed = list.slice(0, 200);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export function removeFromArchive(id: string): void {
  const list = getArchive().filter((d) => d.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/* ────────── 5. 인쇄 — 양식 그대로 ────────── */

/**
 * 다운로드한 노임대장 .xlsx 파일과 동일한 모양으로 인쇄.
 *
 * 흐름:
 * 1) ExcelJS로 양식 로드 + 데이터 채움
 * 2) SheetJS로 다시 읽어 sheet_to_html로 HTML 변환 (셀병합·레이아웃 보존)
 * 3) 새 창에 띄우고 인쇄 다이얼로그
 */
export async function buildLedgerPrintHtmlFromXlsx(doc: LedgerDoc): Promise<string> {
  return buildLedgerPrintPaged(doc);
}

function buildLedgerPrintPaged(doc: LedgerDoc): string {
  const ymTitle = `일용노무비지급명세서(${doc.yearMonth.slice(2, 4)}년 ${doc.yearMonth.slice(5, 7)}월)`;
  const PEOPLE_PER_PAGE = 10;

  const totals = doc.rows.reduce(
    (acc, r) => ({
      gongsu: acc.gongsu + r.totalGongsu,
      wage: acc.wage + r.totalWage,
      employmentInsurance: acc.employmentInsurance + r.employmentInsurance,
      incomeTax: acc.incomeTax + r.incomeTax,
      healthInsurance: acc.healthInsurance + r.healthInsurance,
      netPaid: acc.netPaid + r.netPaid,
    }),
    { gongsu: 0, wage: 0, employmentInsurance: 0, incomeTax: 0, healthInsurance: 0, netPaid: 0 },
  );

  const chunks: LedgerRow[][] = [];
  for (let i = 0; i < doc.rows.length; i += PEOPLE_PER_PAGE) {
    chunks.push(doc.rows.slice(i, i + PEOPLE_PER_PAGE));
  }
  if (chunks.length === 0) chunks.push([]);

  const headerInfo = `
    <table class="ldgr-info">
      <tr>
        <td class="lbl">상호</td>
        <td>${escapeHtml(doc.companyName)}</td>
        <td class="title" rowspan="2" colspan="2">${escapeHtml(ymTitle)}</td>
        <td class="lbl">기간</td>
        <td colspan="2">${escapeHtml(doc.periodStart)} ~ ${escapeHtml(doc.periodEnd)}</td>
      </tr>
      <tr>
        <td class="lbl">현장명</td>
        <td>${escapeHtml(doc.siteName)}</td>
        <td class="lbl">고용관리책임자</td>
        <td colspan="2">${escapeHtml(doc.manager.name || '-')}</td>
      </tr>
    </table>
  `;

  const dayHead1 = Array.from({ length: 15 }, (_, i) => `<th class="d">${i + 1}</th>`).join('') + '<th class="d"></th>';
  const dayHead2 = Array.from({ length: 16 }, (_, i) => `<th class="d">${i + 16}</th>`).join('');
  const colHead = `
    <thead>
      <tr>
        <th rowspan="3" style="width:22px;">순서</th>
        <th rowspan="3" style="width:60px;">성명</th>
        <th rowspan="3" style="width:90px;">주민번호</th>
        <th colspan="2" rowspan="3" style="width:120px;">주소 / 직종</th>
        <th colspan="16">공수 (1 ~ 31일)</th>
        <th rowspan="3" style="width:36px;">총공수</th>
        <th rowspan="3" style="width:62px;">단가</th>
        <th rowspan="3" style="width:78px;">노무비총액</th>
        <th rowspan="3" style="width:50px;">고용보험</th>
        <th rowspan="3" style="width:50px;">소득세</th>
        <th rowspan="3" style="width:50px;">건강보험</th>
        <th rowspan="3" style="width:78px;">실지급</th>
      </tr>
      <tr class="day-row">${dayHead1}</tr>
      <tr class="day-row">${dayHead2}</tr>
    </thead>
  `;

  const renderPerson = (r: LedgerRow): string => {
    const d1 = r.dailyGongsu.slice(0, 15).map((v) => `<td class="d">${v > 0 ? v.toFixed(1) : ''}</td>`).join('') + '<td class="d"></td>';
    const d2 = r.dailyGongsu.slice(15, 31).map((v) => `<td class="d">${v > 0 ? v.toFixed(1) : ''}</td>`).join('');
    return `
      <tr class="r-top">
        <td rowspan="2" class="c">${r.order}</td>
        <td class="strong">${escapeHtml(r.name)}</td>
        <td class="mono small">${escapeHtml(r.idNumber)}</td>
        <td colspan="2" class="addr">${escapeHtml(r.address)}</td>
        ${d1}
        <td rowspan="2" class="n strong">${r.totalGongsu.toFixed(1)}</td>
        <td rowspan="2" class="n">${r.dailyWage.toLocaleString()}</td>
        <td rowspan="2" class="n strong">${r.totalWage.toLocaleString()}</td>
        <td rowspan="2" class="n">${r.employmentInsurance.toLocaleString()}</td>
        <td rowspan="2" class="n">${r.incomeTax.toLocaleString()}</td>
        <td rowspan="2" class="n">${r.healthInsurance.toLocaleString()}</td>
        <td rowspan="2" class="n net">${r.netPaid.toLocaleString()}</td>
      </tr>
      <tr class="r-bot">
        <td class="small mono">${escapeHtml(r.phone)}</td>
        <td colspan="3" class="small">${escapeHtml(extractRole(r.trade))}</td>
        ${d2}
      </tr>
    `;
  };

  const totalRow = `
    <tr class="totals">
      <td colspan="5" class="c strong">총계 (${doc.rows.length}명)</td>
      <td colspan="16"></td>
      <td class="n strong">${totals.gongsu.toFixed(1)}</td>
      <td></td>
      <td class="n strong">${totals.wage.toLocaleString()}</td>
      <td class="n">${totals.employmentInsurance.toLocaleString()}</td>
      <td class="n">${totals.incomeTax.toLocaleString()}</td>
      <td class="n">${totals.healthInsurance.toLocaleString()}</td>
      <td class="n net strong">${totals.netPaid.toLocaleString()}</td>
    </tr>
  `;

  const pages = chunks
    .map((chunk, ci) => {
      const isLast = ci === chunks.length - 1;
      const breakStyle = !isLast ? 'page-break-after: always;' : '';
      return `
        <section class="ldgr-page" style="${breakStyle}">
          ${headerInfo}
          <table class="ldgr-data">
            ${colHead}
            <tbody>
              ${chunk.map(renderPerson).join('')}
              ${isLast ? totalRow : ''}
            </tbody>
          </table>
          <div class="ldgr-pagenum">${ci + 1} / ${chunks.length} 페이지</div>
        </section>
      `;
    })
    .join('');

  return pages + `
    <style>
      @page { size: A4 landscape; margin: 8mm 6mm; }
      body { font-size: 9px !important; padding: 0 !important; }

      .ldgr-page { page-break-inside: avoid; }
      .ldgr-page + .ldgr-page { padding-top: 6px; }

      .ldgr-info { width: 100%; border-collapse: collapse; margin-bottom: 4px; font-size: 10px; }
      .ldgr-info td { padding: 4px 8px; border: 1px solid #1f1d1b; }
      .ldgr-info .lbl { background: #f5f3ef; font-weight: 700; width: 70px; text-align: center; }
      .ldgr-info .title { text-align: center; font-size: 14px; font-weight: 800; letter-spacing: -0.02em; background: #fafaf6; }

      .ldgr-data { width: 100%; border-collapse: collapse; font-size: 9px; table-layout: auto; }
      .ldgr-data th, .ldgr-data td { border: 1px solid #1f1d1b; padding: 2px 3px; vertical-align: middle; word-break: keep-all; }
      .ldgr-data th { background: #f0ece4; font-weight: 700; text-align: center; font-size: 9px; line-height: 1.2; }
      .ldgr-data .d { width: 18px; text-align: center; padding: 1px 0; font-size: 8.5px; }
      .ldgr-data .c { text-align: center; }
      .ldgr-data .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .ldgr-data .strong { font-weight: 700; }
      .ldgr-data .net { color: #047857; font-weight: 700; }
      .ldgr-data .mono { font-family: ui-monospace, 'JetBrains Mono', Consolas, monospace; }
      .ldgr-data .small { font-size: 8.5px; color: #4b4842; }
      .ldgr-data .addr { font-size: 8.5px; }
      .ldgr-data .totals td { background: #fafaf6; font-weight: 700; }

      .ldgr-pagenum { text-align: center; margin-top: 6px; font-size: 9px; color: #6c6a65; }

      /* thead가 매 페이지 자동 반복되도록 */
      .ldgr-data thead { display: table-header-group; }
      .ldgr-data tbody { display: table-row-group; }

      /* 사람 단위 페이지 끊김 방지 */
      .ldgr-data tr.r-top { page-break-after: avoid; }
      .ldgr-data tr.r-bot { page-break-before: avoid; }
    </style>
  `;
}

export function buildLedgerPrintHtmlSimple(doc: LedgerDoc): string {
  const totalDays = doc.rows.reduce((s, r) => s + r.totalGongsu, 0);
  const totalWage = doc.rows.reduce((s, r) => s + r.totalWage, 0);
  const totalNet = doc.rows.reduce((s, r) => s + r.netPaid, 0);
  const totalDeduction = doc.rows.reduce(
    (s, r) => s + r.employmentInsurance + r.incomeTax + r.healthInsurance,
    0,
  );

  const rowsHtml = doc.rows
    .map((r) => {
      const deduction = r.employmentInsurance + r.incomeTax + r.healthInsurance;
      return `
        <tr>
          <td class="c">${r.order}</td>
          <td class="strong">${escapeHtml(r.name)}</td>
          <td class="mono">${escapeHtml(r.idNumber)}</td>
          <td>${escapeHtml(extractRole(r.trade))}</td>
          <td class="n">${r.totalGongsu.toFixed(1)}</td>
          <td class="n">${r.dailyWage.toLocaleString()}</td>
          <td class="n strong">${r.totalWage.toLocaleString()}</td>
          <td class="n">${r.employmentInsurance.toLocaleString()}</td>
          <td class="n">${r.incomeTax.toLocaleString()}</td>
          <td class="n">${r.healthInsurance.toLocaleString()}</td>
          <td class="n ded">${deduction.toLocaleString()}</td>
          <td class="n net">${r.netPaid.toLocaleString()}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <header class="ld-head">
      <p class="ld-title">일용노무비지급명세서 (노임대장)</p>
      <p class="ld-sub">${escapeHtml(doc.yearMonth)}월 · ${escapeHtml(doc.siteName)}</p>
    </header>

    <table class="ld-info">
      <tr>
        <td class="lbl">상호</td>
        <td>${escapeHtml(doc.companyName)}</td>
        <td class="lbl">기간</td>
        <td>${escapeHtml(doc.periodStart)} ~ ${escapeHtml(doc.periodEnd)}</td>
      </tr>
      <tr>
        <td class="lbl">현장명</td>
        <td>${escapeHtml(doc.siteName)}</td>
        <td class="lbl">고용관리책임자</td>
        <td>${escapeHtml(doc.manager.name || '-')}</td>
      </tr>
    </table>

    <table class="ld-data">
      <thead>
        <tr>
          <th style="width:4%;">번호</th>
          <th style="width:9%;">성명</th>
          <th style="width:13%;">주민번호</th>
          <th style="width:9%;">직종</th>
          <th style="width:6%;">근무일</th>
          <th style="width:9%;">일당</th>
          <th style="width:11%;">노무비총액</th>
          <th style="width:8%;">고용보험</th>
          <th style="width:8%;">소득세</th>
          <th style="width:8%;">건강보험</th>
          <th style="width:7%;">공제계</th>
          <th style="width:8%;">실지급</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          <td colspan="4" class="c strong">합계 (${doc.rows.length}명)</td>
          <td class="n strong">${totalDays.toFixed(1)}</td>
          <td></td>
          <td class="n strong">${totalWage.toLocaleString()}</td>
          <td colspan="3"></td>
          <td class="n ded strong">${totalDeduction.toLocaleString()}</td>
          <td class="n net strong">${totalNet.toLocaleString()}</td>
        </tr>
      </tfoot>
    </table>

    <p class="ld-note">
      * 본 명세서는 일용근로자 노임 지급 내역의 회사 보관용 양식입니다. 일자별 공수 상세는 양식(.xlsx) 파일에서 확인하세요.
    </p>

    <div class="ld-foot">
      <span>발행일 : ${new Date().toLocaleDateString('ko-KR')}</span>
      <span>${escapeHtml(doc.companyName)} (인)</span>
    </div>

    <style>
      .ld-head { text-align: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #1f1d1b; }
      .ld-title { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
      .ld-sub { font-size: 12px; color: #6c6a65; margin: 4px 0 0; }

      .ld-info { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11px; }
      .ld-info td { padding: 6px 10px; border: 1px solid #b8b3a8; }
      .ld-info .lbl { background: #f5f3ef; font-weight: 700; width: 110px; text-align: center; }

      .ld-data { width: 100%; border-collapse: collapse; font-size: 10.5px; }
      .ld-data th, .ld-data td { padding: 5px 6px; border: 1px solid #b8b3a8; }
      .ld-data th { background: #f5f3ef; font-weight: 700; text-align: center; font-size: 10px; }
      .ld-data tfoot td { background: #fafaf6; }
      .c { text-align: center; }
      .n { text-align: right; font-variant-numeric: tabular-nums; }
      .mono { font-family: ui-monospace, 'JetBrains Mono', Consolas, monospace; font-size: 10px; }
      .strong { font-weight: 700; }
      .ded { color: #a855f7; }
      .net { color: #047857; font-weight: 700; }

      .ld-note { font-size: 10px; color: #6c6a65; margin-top: 10px; line-height: 1.5; }
      .ld-foot { display: flex; justify-content: space-between; margin-top: 16px; font-size: 11px; color: #6c6a65; }
    </style>
  `;
}

function extractRole(trade: string): string {
  // "미지정 | 단순노무자 | 직영" 같은 형태에서 가운데(직종)만 뽑기
  const parts = trade.split('|').map((p) => p.trim());
  if (parts.length >= 2) return parts[1];
  return trade;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

