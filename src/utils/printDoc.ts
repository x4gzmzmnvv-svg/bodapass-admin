/**
 * 한글 인쇄용 HTML 문서를 새 창에 띄우는 헬퍼.
 *
 * 사용 시:
 *   openPrintWindow({
 *     title: '2026년 5월 임금명세서 — 한동현',
 *     bodyHtml: '<h1>...</h1>...',
 *     style: '...추가 CSS...',
 *   });
 *
 * 사용자는 발생한 인쇄 다이얼로그에서 "PDF로 저장"을 선택하면 됩니다.
 * — 한글 폰트(Pretendard)는 부모 페이지의 prelink 캐시를 그대로 재사용하므로 별도 임베드 불필요.
 */

export interface PrintDocOptions {
  /** 창 타이틀 (브라우저 탭 타이틀 + 인쇄 시 헤더에 일부 표기) */
  title: string;
  /** 인쇄될 본문 HTML */
  bodyHtml: string;
  /** 추가 CSS — 기본 베이스에 덧붙여짐 */
  style?: string;
  /** 인쇄 다이얼로그 자동 호출 여부 (기본 true) */
  autoPrint?: boolean;
  /** A4 가로/세로 (기본 'portrait') */
  orientation?: 'portrait' | 'landscape';
}

const BASE_STYLE = `
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
      system-ui, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
    color: #1f1d1b;
    margin: 0;
    padding: 16px;
    font-size: 12px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 { margin: 0; letter-spacing: -0.02em; font-weight: 700; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; }
  h3 { font-size: 14px; }
  p { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #b8b3a8; padding: 6px 8px; text-align: left; vertical-align: middle; }
  th { background: #f5f3ef; font-weight: 700; font-size: 11px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .center { text-align: center; }
  .muted { color: #6c6a65; }
  .small { font-size: 11px; }
  .strong { font-weight: 700; }

  .doc-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    border-bottom: 2px solid #1f1d1b; padding-bottom: 10px; margin-bottom: 12px;
  }
  .doc-head__title { font-size: 22px; font-weight: 800; }
  .doc-head__sub { font-size: 12px; color: #6c6a65; margin-top: 2px; }
  .doc-head__company { text-align: right; font-size: 12px; }

  .kv-grid {
    display: grid; grid-template-columns: 100px 1fr 100px 1fr; gap: 0;
    border: 1px solid #b8b3a8; margin-bottom: 12px;
  }
  .kv-grid > div {
    padding: 6px 8px; border-right: 1px solid #b8b3a8; border-bottom: 1px solid #b8b3a8;
  }
  .kv-grid > div.k { background: #f5f3ef; font-weight: 700; font-size: 11px; }
  .kv-grid > div:nth-child(4n) { border-right: 0; }

  .footer-row {
    margin-top: 16px; display: flex; justify-content: space-between; font-size: 11px; color: #6c6a65;
  }

  @media print {
    .no-print { display: none !important; }
  }
`;

export function openPrintWindow(opts: PrintDocOptions): void {
  const { title, bodyHtml, style = '', autoPrint = true, orientation = 'portrait' } = opts;
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) {
    window.alert('팝업이 차단되었습니다. 브라우저 주소창의 팝업 차단을 해제하고 다시 시도해주세요.');
    return;
  }
  const html = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css" />
    <style>
      ${BASE_STYLE.replace('A4 portrait', 'A4 ' + orientation)}
      ${style}
    </style>
  </head>
  <body>
    ${bodyHtml}
    <div class="no-print" style="margin-top:18px; text-align:center; padding:10px; background:#eef2ff; border-radius:8px; font-size:13px;">
      <button onclick="window.print()" style="padding:8px 14px; border-radius:6px; background:#4f6fb8; color:#fff; border:0; font-weight:700; cursor:pointer;">🖨 인쇄 / PDF 저장</button>
      <span style="margin-left:8px; color:#475569;">인쇄 다이얼로그에서 <strong>"PDF로 저장"</strong>을 선택하세요.</span>
    </div>
  </body>
</html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  if (autoPrint) {
    // 폰트 로드 후 인쇄 다이얼로그
    w.onload = () => {
      window.setTimeout(() => {
        try { w.focus(); w.print(); } catch { /* 사용자가 수동으로 인쇄 가능 */ }
      }, 400);
    };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
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

export function krw(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원';
}
