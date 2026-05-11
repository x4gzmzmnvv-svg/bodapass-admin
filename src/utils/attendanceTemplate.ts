// FILE_VERSION 1777960000
/**
 * 출역 일괄 입력 양식 (.xlsx) — 우리 시스템 전용
 *
 *  외부 업체 「근로자현황(변환용)」 양식을 참조하되, 우리는 출역(일자별 공수) 입력까지
 *  함께 처리해야 하므로 다음 두 영역을 한 시트에 결합:
 *
 *   [A] 근로자 기본 정보 (좌측 7컬럼) — 시스템에 등록된 멤버 자동 채움
 *       1. 근로자코드 (memberId)
 *       2. 이름
 *       3. 주민번호 (마스킹)
 *       4. 연락처
 *       5. 직종
 *       6. 단가 (원/공수)
 *       7. 외국인 (Y/N)
 *
 *   [B] 일자별 공수 그리드 (우측, 그 달의 일수만큼) — 사용자가 직접 채움
 *       각 셀 값은 0 / 0.5 / 1.0 / 1.5 / 2.0 중 하나.
 *
 *   [C] 합계 공수 (마지막 컬럼) — 우측 그리드 SUM 자동 계산.
 *
 *  업로드 시 동일 시트 구조를 readback 하여 attendance 버킷에 적재 (parser는 별도 phase).
 */

import ExcelJS from 'exceljs';
import { localDateStr } from './dateLocal';
import type { TeamMember } from '../api/team.types';
import type { Site } from '../api/site.types';

interface BuildArgs {
  site: Site;
  members: TeamMember[];
  /** 'YYYY-MM' */
  yearMonth: string;
  /** 양식 발행 회사명 (헤더 표시용) */
  companyName?: string;
}

/** 그 달의 일수 — 1일 ~ N일 */
function daysInMonth(yearMonth: string): number {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export async function buildAttendanceTemplateWorkbook(args: BuildArgs): Promise<ExcelJS.Workbook> {
  const { site, members, yearMonth, companyName } = args;
  const days = daysInMonth(yearMonth);
  const [year, month] = yearMonth.split('-').map(Number);

  const wb = new ExcelJS.Workbook();
  wb.creator = '보다패스 (BodaPass)';
  wb.created = new Date();

  const ws = wb.addWorksheet(`출역입력_${year}.${String(month).padStart(2, '0')}`, {
    views: [{ state: 'frozen', xSplit: 7, ySplit: 5 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
  });

  // ───── 1행: 제목 ─────
  const titleRow = ws.getRow(1);
  ws.mergeCells(1, 1, 1, 7 + days + 1);
  titleRow.getCell(1).value = `출역 일괄 입력 양식 — ${year}년 ${month}월`;
  titleRow.getCell(1).font = { name: '맑은 고딕', size: 16, bold: true, color: { argb: 'FF0F172A' } };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 28;

  // ───── 2행: 메타 정보 (현장명·발행처·발행일) ─────
  const metaRow = ws.getRow(2);
  ws.mergeCells(2, 1, 2, 4);
  metaRow.getCell(1).value = `현장: ${site.name}`;
  ws.mergeCells(2, 5, 2, 8);
  metaRow.getCell(5).value = companyName ? `발행처: ${companyName}` : '';
  ws.mergeCells(2, 9, 2, 7 + days + 1);
  metaRow.getCell(9).value = `발행일: ${localDateStr()}  ·  대상 인원: ${members.length}명`;
  [1, 5, 9].forEach((c) => {
    metaRow.getCell(c).font = { name: '맑은 고딕', size: 10, color: { argb: 'FF475569' } };
    metaRow.getCell(c).alignment = { horizontal: 'left', vertical: 'middle' };
  });
  metaRow.height = 18;

  // ───── 3행: 안내 ─────
  const guideRow = ws.getRow(3);
  ws.mergeCells(3, 1, 3, 7 + days + 1);
  guideRow.getCell(1).value =
    '※ 일자별 셀에 공수(0 / 0.5 / 1.0 / 1.5 / 2.0)만 입력하세요. ' +
    '근로자 기본 정보는 시스템에 등록된 값으로 자동 채워져 있으며, 수정 시 업로드 단계에서 검증됩니다.';
  guideRow.getCell(1).font = { name: '맑은 고딕', size: 9, italic: true, color: { argb: 'FF94A3B8' } };
  guideRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  guideRow.height = 20;

  // ───── 4행: (빈 줄, 시각적 여백) ─────
  ws.getRow(4).height = 6;

  // ───── 5행: 컬럼 헤더 ─────
  const headerRow = ws.getRow(5);
  const fixedHeaders = ['근로자코드', '이름', '주민번호(마스킹)', '연락처', '직종', '단가(원)', '외국인'];
  fixedHeaders.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h;
  });
  // 일자 헤더 (1일 ~ N일)
  for (let d = 1; d <= days; d++) {
    const c = headerRow.getCell(7 + d);
    c.value = `${d}일`;
  }
  // 합계 컬럼
  headerRow.getCell(7 + days + 1).value = '합계공수';

  // 헤더 스타일
  for (let col = 1; col <= 7 + days + 1; col++) {
    const c = headerRow.getCell(col);
    c.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: col <= 7 ? 'FF0F766E' : col === 7 + days + 1 ? 'FF115E59' : 'FF14B8A6' },
    };
    c.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  }
  headerRow.height = 28;

  // 컬럼 폭
  ws.getColumn(1).width = 12; // 근로자코드
  ws.getColumn(2).width = 11; // 이름
  ws.getColumn(3).width = 16; // 주민번호
  ws.getColumn(4).width = 14; // 연락처
  ws.getColumn(5).width = 10; // 직종
  ws.getColumn(6).width = 11; // 단가
  ws.getColumn(7).width = 7;  // 외국인
  for (let d = 1; d <= days; d++) {
    ws.getColumn(7 + d).width = 5; // 일자 — 공수 한 자리수
  }
  ws.getColumn(7 + days + 1).width = 9; // 합계

  // ───── 6행~: 근로자 데이터 ─────
  members.forEach((m, idx) => {
    const r = 6 + idx;
    const row = ws.getRow(r);

    row.getCell(1).value = m.id;
    row.getCell(2).value = m.name;
    row.getCell(3).value = m.idNumberMasked;
    row.getCell(4).value = m.phone;
    row.getCell(5).value = m.role ?? '';
    row.getCell(6).value = m.dailyWage ?? 0;
    row.getCell(7).value = (m.idType === 2) ? 'Y' : 'N';

    // 일자별 공수 — 빈 값 (사용자가 직접 입력)
    // 셀 데이터 검증: 0/0.5/1/1.5/2 만 허용
    for (let d = 1; d <= days; d++) {
      const c = row.getCell(7 + d);
      c.value = null;
      c.dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"0,0.5,1,1.5,2"'],
        showErrorMessage: true,
        errorStyle: 'warning',
        errorTitle: '공수 입력 오류',
        error: '공수는 0 / 0.5 / 1 / 1.5 / 2 중에서 선택하세요.',
      };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.numFmt = '0.0';
    }

    // 합계 공수 (자동 계산식)
    const startCol = colLetter(8);             // 8번 = 1일 컬럼
    const endCol = colLetter(7 + days);         // 마지막 일자 컬럼
    const sumCell = row.getCell(7 + days + 1);
    sumCell.value = { formula: `SUM(${startCol}${r}:${endCol}${r})` };
    sumCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sumCell.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FF0F766E' } };
    sumCell.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FFF0FDFA' },
    };
    sumCell.numFmt = '0.0';

    // 행 공통 스타일
    for (let col = 1; col <= 7 + days + 1; col++) {
      const c = row.getCell(col);
      c.border = {
        top: { style: 'hair', color: { argb: 'FFE2E8F0' } },
        left: { style: 'hair', color: { argb: 'FFE2E8F0' } },
        right: { style: 'hair', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } },
      };
      if (!c.font) c.font = { name: '맑은 고딕', size: 10, color: { argb: 'FF0F172A' } };
      if (!c.alignment) c.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    // 좌측 고정 정보 — 살짝 회색 배경 (입력 셀과 시각적 구분)
    for (let col = 1; col <= 7; col++) {
      row.getCell(col).fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: 'FFF8FAFC' },
      };
    }
    // 단가는 우측 정렬
    row.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(6).numFmt = '#,##0';
    row.height = 22;
  });

  // ───── 합계 행 (마지막) ─────
  const totalRow = ws.getRow(6 + members.length);
  ws.mergeCells(totalRow.number, 1, totalRow.number, 7);
  totalRow.getCell(1).value = '일자별 합계 →';
  totalRow.getCell(1).font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FF475569' } };
  totalRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
  totalRow.getCell(1).fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  };

  for (let d = 1; d <= days; d++) {
    const colIdx = 7 + d;
    const colL = colLetter(colIdx);
    const startRow = 6;
    const endRow = 6 + members.length - 1;
    const c = totalRow.getCell(colIdx);
    c.value = members.length > 0
      ? { formula: `SUM(${colL}${startRow}:${colL}${endRow})` }
      : 0;
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FF0F766E' } };
    c.numFmt = '0.0';
    c.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FFF0FDFA' },
    };
  }
  // 총합 (모든 멤버, 모든 일자)
  const grand = totalRow.getCell(7 + days + 1);
  if (members.length > 0) {
    const gStart = colLetter(8);
    const gEnd = colLetter(7 + days);
    grand.value = { formula: `SUM(${gStart}6:${gEnd}${6 + members.length - 1})` };
  } else {
    grand.value = 0;
  }
  grand.alignment = { horizontal: 'center', vertical: 'middle' };
  grand.font = { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  grand.fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FF115E59' },
  };
  grand.numFmt = '0.0';
  totalRow.height = 26;

  return wb;
}

/** 공용 헬퍼 — 1=A, 2=B, ..., 27=AA, ... */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 다운로드 — 빌드 + 파일 저장 */
export async function downloadAttendanceTemplateXlsx(args: BuildArgs): Promise<void> {
  const wb = await buildAttendanceTemplateWorkbook(args);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `출역입력_${args.site.name}_${args.yearMonth}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}
