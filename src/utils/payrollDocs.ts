/**
 * 임금명세서 / 근로내용확인신고서 HTML 템플릿 생성기.
 *
 * 모든 양식은 한국 실무에 맞게 단순화됐고, 인쇄 시 A4 한 장에 깔끔히 들어가도록 설계.
 */

import type { WageMonthSummary, WageRow } from '../api/wage.types';
import { escapeHtml, krw } from './printDoc';

interface CompanyInfo {
  companyName: string;
  bizRegNo?: string;
  representative?: string;
  address?: string;
}

interface SiteInfo {
  name: string;
  address: string;
  manager: string;
  managerPhone: string;
}

/* ────────────────── 1) 임금명세서 (단일 팀원) ────────────────── */

export function buildPayslipHtml(opts: {
  row: WageRow;
  yearMonth: string; // 'YYYY-MM'
  company: CompanyInfo;
  site: SiteInfo;
}): string {
  const { row, yearMonth, company, site } = opts;
  const [y, m] = yearMonth.split('-');

  return `
    <header class="doc-head">
      <div>
        <p class="doc-head__title">임금 명세서</p>
        <p class="doc-head__sub">${escapeHtml(y)}년 ${escapeHtml(m)}월분</p>
      </div>
      <div class="doc-head__company">
        <p class="strong">${escapeHtml(company.companyName)}</p>
        ${company.bizRegNo ? `<p class="muted">사업자번호 ${escapeHtml(company.bizRegNo)}</p>` : ''}
        ${company.representative ? `<p class="muted">대표 ${escapeHtml(company.representative)}</p>` : ''}
      </div>
    </header>

    <h2 style="margin-bottom:8px;">근로자 정보</h2>
    <div class="kv-grid" style="grid-template-columns: 100px 1fr 100px 1fr;">
      <div class="k">성명</div><div>${escapeHtml(row.memberName)}</div>
      <div class="k">주민번호</div><div>${escapeHtml(row.idNumberMasked)}</div>
      <div class="k">직종</div><div>${escapeHtml(row.role)}</div>
      <div class="k">근무 현장</div><div>${escapeHtml(site.name)}</div>
    </div>

    <h2 style="margin-bottom:8px;">지급·공제 내역</h2>
    <table>
      <thead>
        <tr>
          <th style="width:35%;">항목</th>
          <th class="num" style="width:25%;">금액</th>
          <th style="width:40%;">비고</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>기본급 <span class="muted">(일당 × 근무일)</span></td>
          <td class="num strong">${krw(row.baseAmount)}</td>
          <td class="small muted">${row.dailyWage.toLocaleString()}원 × ${row.workDays}일</td>
        </tr>
        <tr><td colspan="3" style="background:#f5f3ef; font-weight:700; padding:4px 8px; font-size:11px;">공제 항목</td></tr>
        <tr><td>국민연금</td><td class="num">${krw(row.deductionPension)}</td><td class="small muted">기본급의 4.5%</td></tr>
        <tr><td>건강보험</td><td class="num">${krw(row.deductionHealth)}</td><td class="small muted">기본급의 약 3.5%</td></tr>
        <tr><td>고용보험</td><td class="num">${krw(row.deductionEmployment)}</td><td class="small muted">기본급의 0.9%</td></tr>
        <tr><td>산재보험</td><td class="num">${krw(row.deductionAccident)}</td><td class="small muted">사업주 부담</td></tr>
        <tr><td>소득세</td><td class="num">${krw(row.deductionIncomeTax)}</td><td class="small muted">간이세액</td></tr>
        <tr><td>지방세</td><td class="num">${krw(row.deductionLocalTax)}</td><td class="small muted">소득세의 10%</td></tr>
        <tr style="background:#fef2f2;">
          <td class="strong">공제계</td>
          <td class="num strong">${krw(row.deductionTotal)}</td>
          <td></td>
        </tr>
        <tr style="background:#ecfdf5;">
          <td class="strong" style="font-size:13px;">실 지급액</td>
          <td class="num strong" style="font-size:14px;">${krw(row.netAmount)}</td>
          <td class="small muted">계좌이체 예정</td>
        </tr>
      </tbody>
    </table>

    <p class="small muted" style="margin-top:10px;">
      * 본 명세서는 근로기준법 제48조에 따라 발급되며, 공제 항목 산출 기준은 회사 임금규정에 의합니다.
    </p>

    <div class="footer-row">
      <span>발행일: ${new Date().toLocaleDateString('ko-KR')}</span>
      <span>${escapeHtml(company.companyName)} ${company.representative ? `· 대표 ${escapeHtml(company.representative)}` : ''}</span>
    </div>
  `;
}

/* ────────── 2) 일괄 임금명세서 (여러 팀원을 한 문서에 페이지 나눠 인쇄) ────────── */

export function buildBulkPayslipHtml(opts: {
  rows: WageRow[];
  yearMonth: string;
  company: CompanyInfo;
  site: SiteInfo;
}): string {
  const { rows, yearMonth, company, site } = opts;
  const pages = rows.map((r, i) => `
    <section style="${i > 0 ? 'page-break-before: always;' : ''}">
      ${buildPayslipHtml({ row: r, yearMonth, company, site })}
    </section>
  `).join('\n');
  return pages;
}

/* ────────── 3) 근로내용확인신고서 (고용센터 제출용) ────────── */

export function buildLaborReportHtml(opts: {
  data: WageMonthSummary;
  company: CompanyInfo;
  site: SiteInfo;
}): string {
  const { data, company, site } = opts;

  const rowsHtml = data.rows.map((r, i) => `
    <tr>
      <td class="center">${i + 1}</td>
      <td>${escapeHtml(r.memberName)}</td>
      <td class="center small">${escapeHtml(r.idNumberMasked)}</td>
      <td class="center">${escapeHtml(r.role)}</td>
      <td class="num">${r.workDays}</td>
      <td class="num">${r.dailyWage.toLocaleString()}</td>
      <td class="num strong">${r.baseAmount.toLocaleString()}</td>
    </tr>
  `).join('');

  return `
    <header class="doc-head">
      <div>
        <p class="doc-head__title">근로내용확인신고서</p>
        <p class="doc-head__sub">${data.year}년 ${String(data.month).padStart(2, '0')}월 — 일용근로자 근무 명세</p>
      </div>
      <div class="doc-head__company">
        <p class="strong">${escapeHtml(company.companyName)}</p>
        ${company.bizRegNo ? `<p class="muted">사업자번호 ${escapeHtml(company.bizRegNo)}</p>` : ''}
      </div>
    </header>

    <h2 style="margin-bottom:8px;">사업장 정보</h2>
    <div class="kv-grid">
      <div class="k">사업장명</div><div>${escapeHtml(site.name)}</div>
      <div class="k">소재지</div><div>${escapeHtml(site.address)}</div>
      <div class="k">현장담당자</div><div>${escapeHtml(site.manager)}</div>
      <div class="k">연락처</div><div>${escapeHtml(site.managerPhone)}</div>
    </div>

    <h2 style="margin-bottom:8px;">근로자별 근무 명세 (${data.rows.length}명)</h2>
    <table>
      <thead>
        <tr>
          <th class="center" style="width:5%;">번호</th>
          <th style="width:14%;">성명</th>
          <th class="center" style="width:18%;">주민번호</th>
          <th class="center" style="width:12%;">직종</th>
          <th class="num" style="width:9%;">근무일</th>
          <th class="num" style="width:14%;">일당</th>
          <th class="num" style="width:18%;">총 임금</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
      <tfoot>
        <tr style="background:#f5f3ef;">
          <td colspan="4" class="strong center">합계</td>
          <td class="num strong">${data.totalDays}</td>
          <td></td>
          <td class="num strong">${data.totalBase.toLocaleString()}</td>
        </tr>
      </tfoot>
    </table>

    <p class="small muted" style="margin-top:10px;">
      * 본 신고서는 고용보험법 시행령 제104조의2에 따른 일용근로자 근로내용 확인 신고용 양식입니다.
      <br/>* 실제 신고는 고용·산재보험 토탈서비스(EDI) 또는 관할 고용센터를 통해 제출해 주세요.
    </p>

    <div class="footer-row">
      <span>발행일: ${new Date().toLocaleDateString('ko-KR')}</span>
      <span>${escapeHtml(company.companyName)} ${company.representative ? `· 대표 ${escapeHtml(company.representative)} (인)` : ''}</span>
    </div>
  `;
}
