// FILE_VERSION 1777800100
/**
 * 안전관리 페이지 — Phase 1 차별화 기능 4종 포함
 *  · 발송함     : 보낸 메시지 표 (검색·필터·인쇄·CSV) + 행 클릭 상세 + 재발송
 *  · 카테고리   : 12종 표준 (적용 공종 표시) + 사용자 정의 추가/수정/삭제 (예정)
 *  · 통계       : 카테고리별·일자별·채널별 합계
 *  · 감사 로그  : 누가 언제 무엇을 발송 (불변)
 *
 * 차별화 4종:
 *   1) 출퇴근 연동 — 발송 시 「오늘 출근자만」 옵션
 *   2) 공종 기반 추천 — 상단 「오늘 추천」 카드 + 원클릭 발송
 *   3) 확인 상태 추적 — 발송함 「확인 N/M」 + 수신자 상세 모달
 *   4) 미확인자 재발송 — 행에서 ↺ 재발송 버튼
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Tooltip } from '../components/Tooltip';
import { safetyApi } from '../api/safety';
import { siteApi } from '../api/site';
import { teamApi } from '../api/team';
import { useAuth } from '../hooks/useAuth';
import { WeatherAlertBanner } from '../components/WeatherAlertBanner';
import type {
  SafetyAudienceFilter,
  SafetyAudit,
  SafetyCategory,
  SafetyChannel,
  SafetyMessage,
  SafetyStats,
  TodayRecommendationsResponse,
} from '../api/safety.types';
import type { Site } from '../api/site.types';
import './SafetyPage.css';

import { MacSelect } from '../components/MacSelect';
import { MacDatePicker } from '../components/MacDatePicker';
type TabKey = 'OUTBOX' | 'CATEGORIES' | 'STATS' | 'AUDIT';

export function SafetyPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('OUTBOX');
  const [sites, setSites] = useState<Site[]>([]);
  const [categories, setCategories] = useState<SafetyCategory[]>([]);
  const [messages, setMessages] = useState<SafetyMessage[]>([]);
  const [audit, setAudit] = useState<SafetyAudit[]>([]);
  const [stats, setStats] = useState<SafetyStats | null>(null);
  const [recommendations, setRecommendations] = useState<TodayRecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // 다이얼로그 상태
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerInitial, setComposerInitial] = useState<{
    categoryId: string | null;
    categoryTitle: string;
    message: string;
    severity: 'NORMAL' | 'CAUTION' | 'CRITICAL';
  } | null>(null);
  const [detailOpen, setDetailOpen] = useState<SafetyMessage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 헤더 「자동 발송」 배지용 — settings 반영 (모달 닫힐 때 + 마운트 시) */
  const [autoSendSnap, setAutoSendSnap] = useState(() => loadSafetySettings());

  /**
   * URL 「?compose=weather」 진입 시 — 새 발송 다이얼로그를 기상 안전공지 프리셋으로 자동 오픈.
   * 헤더 날씨 옆 「안전공지 발송」 배지에서 navigate('/safety?compose=weather') 로 호출.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('compose') === 'weather') {
      setComposerInitial({
        categoryId: null,
        categoryTitle: '기상 안전공지',
        message: '[기상 안전공지]\n현재 기상 조건상 작업 시 주의가 필요합니다.\n· 미끄럼·시야 제한 등 작업환경 점검\n· 위험 시 작업 중단 및 대피',
        severity: 'CAUTION',
      });
      setComposerOpen(true);
      // URL 파라미터 제거 — 새로고침해도 모달 다시 안 열리게
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // 필터 — 입력 중 (input) / 적용된 (applied) 두 단계
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  /** 「이번 주」 활성화 여부 — true면 요일 칩이 오늘/이번주~이번달 사이에 인라인으로 노출.
      이번 주 안에서 특정 요일(예: 오늘=화)을 클릭해도 weekModeActive 는 유지되어
      「오늘」+「이번 주」 두 버튼이 동시에 파란색으로 보임. */
  const [weekModeActive, setWeekModeActive] = useState(false);
  const [filterSite, setFilterSite] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterQ, setFilterQ] = useState('');
  // 「조회하기」 누른 후의 적용된 값 — filteredMessages 가 이걸 사용
  const [applied, setApplied] = useState<{ from: string; to: string; site: string; category: string; q: string }>(
    { from: '', to: '', site: '', category: '', q: '' },
  );

  function applyFilters() {
    setApplied({ from: filterFrom, to: filterTo, site: filterSite, category: filterCategory, q: filterQ });
  }
  function resetFilters() {
    setFilterFrom(''); setFilterTo(''); setFilterSite(''); setFilterCategory(''); setFilterQ('');
    setApplied({ from: '', to: '', site: '', category: '', q: '' });
  }
  function setQuickPeriod(kind: 'TODAY' | 'WEEK' | 'MONTH' | 'ALL') {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let from = '';
    let to = '';
    if (kind === 'TODAY') {
      from = today; to = today;
      setWeekModeActive(false);
    } else if (kind === 'WEEK') {
      // 이번 주 — 월요일부터 오늘까지
      const day = now.getDay(); // 0=일, 1=월
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - diff);
      from = monday.toISOString().slice(0, 10);
      to = today;
      setWeekModeActive(true);
    } else if (kind === 'MONTH') {
      from = today.slice(0, 7) + '-01';
      to = today;
      setWeekModeActive(false);
    } else {
      // ALL
      setWeekModeActive(false);
    }
    setFilterFrom(from);
    setFilterTo(to);
    // 빠른 토글은 즉시 적용
    setApplied((prev) => ({ ...prev, from, to }));
  }

  async function reload() {
    setLoading(true);
    try {
      // Promise.allSettled — 일부 라우트가 실패해도 나머지는 표시
      const results = await Promise.allSettled([
        siteApi.listSites(),
        safetyApi.listCategories(),
        safetyApi.listMessages(),
        safetyApi.listAudit(),
        safetyApi.stats(),
        safetyApi.todayRecommendations(),
      ]);
      const [siteRes, catRes, msgRes, auditRes, statsRes, recRes] = results;

      if (siteRes.status === 'fulfilled') setSites(siteRes.value.sites);
      else console.error('[Safety] sites failed:', siteRes.reason);

      if (catRes.status === 'fulfilled') setCategories(catRes.value);
      else console.error('[Safety] categories failed:', catRes.reason);

      if (msgRes.status === 'fulfilled') setMessages(msgRes.value.messages);
      else console.error('[Safety] messages failed:', msgRes.reason);

      if (auditRes.status === 'fulfilled') setAudit(auditRes.value.entries);
      else console.error('[Safety] audit failed:', auditRes.reason);

      if (statsRes.status === 'fulfilled') setStats(statsRes.value);
      else console.error('[Safety] stats failed:', statsRes.reason);

      if (recRes.status === 'fulfilled') setRecommendations(recRes.value);
      else console.error('[Safety] recommendations failed:', recRes.reason);
    } catch (err) {
      console.error('[Safety] reload unexpected error:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  const filteredMessages = useMemo(() => {
    return messages.filter((m) => {
      if (applied.from && m.sentAt.slice(0, 10) < applied.from) return false;
      if (applied.to && m.sentAt.slice(0, 10) > applied.to) return false;
      if (applied.site && !m.recipients.some((r) => r.siteId === applied.site)) return false;
      if (applied.category && m.categoryId !== applied.category) return false;
      if (applied.q) {
        const q = applied.q.toLowerCase();
        if (
          !m.message.toLowerCase().includes(q) &&
          !m.categoryTitle.toLowerCase().includes(q) &&
          !m.recipients.some((r) => r.name.toLowerCase().includes(q))
        ) return false;
      }
      return true;
    });
  }, [messages, applied]);

  function exportCsv() {
    const rows = [
      ['발송시각', '카테고리', '심각도', '본문', '대상', '수신자수', '확인', '채널', '발송자', '결과'],
      ...filteredMessages.map((m) => [
        m.sentAt.slice(0, 16).replace('T', ' '),
        m.categoryTitle,
        m.severity,
        m.message.replace(/[\r\n]+/g, ' '),
        audienceLabel(m.audienceFilter),
        String(m.recipients.length),
        `${(m.readReceipts ?? []).filter((r) => r.readAt).length}/${(m.readReceipts ?? []).length}`,
        m.channels.join('+'),
        m.sentBy.name,
        m.status,
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `safety-messages-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function openComposer(initial?: typeof composerInitial) {
    setComposerInitial(initial ?? null);
    setComposerOpen(true);
  }

  /**
   * 인쇄 보고서 — 새 창에 「안전 사고 예방 알림 현황」 형식으로 출력
   *  · 제목 + 기간 + 발행일
   *  · 현장 정보 (현장명·회사·주소·안전담당자)
   *  · 주요 발송 요약 (카테고리별·채널별·확인율)
   *  · 세부 발송 이력 표
   *  · 미확인자 명단 (있는 경우)
   */
  function printReport() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const periodLabel = applied.from && applied.to
      ? `${applied.from} ~ ${applied.to}`
      : applied.from
        ? `${applied.from} 이후`
        : applied.to
          ? `${applied.to} 이전`
          : '전체 기간';

    // 보고서 대상 현장 — 필터된 메시지의 수신자가 속한 현장
    const targetSiteIds = new Set<string>();
    for (const m of filteredMessages) {
      for (const r of m.recipients) {
        if (r.siteId) targetSiteIds.add(r.siteId);
      }
    }
    // applied.site 가 있으면 그 현장만, 아니면 영향받은 모든 현장
    const reportSites = applied.site
      ? sites.filter((s) => s.id === applied.site)
      : sites.filter((s) => targetSiteIds.has(s.id));

    // 카테고리별 합계 (Top)
    const byCategoryMap = new Map<string, { title: string; count: number; severity: string }>();
    for (const m of filteredMessages) {
      const key = m.categoryId ?? '__custom';
      const cur = byCategoryMap.get(key) ?? { title: m.categoryTitle, count: 0, severity: m.severity };
      cur.count++;
      byCategoryMap.set(key, cur);
    }
    const topCategories = Array.from(byCategoryMap.values()).sort((a, b) => b.count - a.count);

    // 채널별
    const smsCount = filteredMessages.filter((m) => m.channels.includes('SMS')).length;
    const appCount = filteredMessages.filter((m) => m.channels.includes('APP')).length;

    // 확인율
    const totalReceipts = filteredMessages.reduce((s, m) => s + (m.readReceipts?.length ?? 0), 0);
    const totalRead = filteredMessages.reduce(
      (s, m) => s + (m.readReceipts?.filter((r) => r.readAt).length ?? 0),
      0,
    );
    const readRate = totalReceipts ? Math.round((totalRead / totalReceipts) * 100) : 0;

    // 심각도별 분포
    const sevCount = {
      CRITICAL: filteredMessages.filter((m) => m.severity === 'CRITICAL').length,
      CAUTION: filteredMessages.filter((m) => m.severity === 'CAUTION').length,
      NORMAL: filteredMessages.filter((m) => m.severity === 'NORMAL').length,
    };

    // 미확인자 명단 — 메시지별로 미확인자 추출
    const unreadByMsg = filteredMessages
      .map((m) => ({
        msg: m,
        unread: (m.readReceipts ?? []).filter((r) => !r.readAt),
      }))
      .filter((x) => x.unread.length > 0);

    const sevLabel = (s: string) => (s === 'CRITICAL' ? '경고' : s === 'CAUTION' ? '주의' : '일반');
    const escapeHtml = (str: string) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // 「1. 개요」 표 — 현장별 한 행: 구분/발송건수/확인율/발송채널/발송자/주요내용
    const overviewRows = reportSites.map((site) => {
      const siteMsgs = filteredMessages.filter((m) =>
        m.recipients.some((r) => r.siteId === site.id),
      );
      const totalR = siteMsgs.reduce((s, m) => s + (m.readReceipts?.length ?? 0), 0);
      const readR = siteMsgs.reduce(
        (s, m) => s + (m.readReceipts?.filter((r) => r.readAt).length ?? 0),
        0,
      );
      const rate = totalR ? Math.round((readR / totalR) * 100) : 0;

      // 채널 통합
      const chSet = new Set<string>();
      siteMsgs.forEach((m) => m.channels.forEach((c) => chSet.add(c)));
      const channels = Array.from(chSet).join('·') || '—';

      // 카테고리 Top 3 (그 현장 한정)
      const catCount = new Map<string, number>();
      siteMsgs.forEach((m) => {
        catCount.set(m.categoryTitle, (catCount.get(m.categoryTitle) ?? 0) + 1);
      });
      const topCats =
        Array.from(catCount.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([title, n]) => `${title}(${n})`)
          .join(', ') || '—';

      return {
        name: site.name,
        agent: site.siteAgent?.name ?? site.manager ?? '—',
        count: siteMsgs.length,
        rate,
        channels,
        topCats,
      };
    });

    // 카테고리 압축 그리드 — 한 행에 6개씩, 카테고리당 [제목 / N건·심각도]
    const categoryGrid = topCategories.length === 0
      ? `<div class="cat-grid-empty muted">발송 이력이 없습니다.</div>`
      : `<div class="cat-grid">${topCategories.map((c) => `
          <div class="cat-cell cat-cell--${c.severity.toLowerCase()}">
            <div class="cat-cell-title">${escapeHtml(c.title)}</div>
            <div class="cat-cell-meta">
              <span class="cat-cell-count">${c.count}건</span>
              <span class="cat-cell-sev">${sevLabel(c.severity)}</span>
            </div>
          </div>
        `).join('')}</div>`;

    const detailRows = filteredMessages.length === 0
      ? `<tr><td colspan="6" class="muted">발송 이력이 없습니다.</td></tr>`
      : filteredMessages.map((m, idx) => {
        const totalR = m.readReceipts?.length ?? 0;
        const readR = m.readReceipts?.filter((r) => r.readAt).length ?? 0;
        const recipientNames = m.recipients
          .slice(0, 4)
          .map((r) => escapeHtml(r.name))
          .join(', ') + (m.recipients.length > 4 ? ` 외 ${m.recipients.length - 4}명` : '');
        return `
          <tr>
            <td class="num">${idx + 1}</td>
            <td>${m.sentAt.slice(0, 16).replace('T', ' ')}</td>
            <td>${escapeHtml(m.categoryTitle)}<br/><span class="muted small">${sevLabel(m.severity)}</span></td>
            <td class="msg">${escapeHtml(m.message)}</td>
            <td>${recipientNames}<br/><span class="muted small">${m.channels.join(', ')}</span></td>
            <td class="num">${readR}/${totalR} (${totalR ? Math.round((readR/totalR)*100) : 0}%)</td>
          </tr>
        `;
      }).join('');

    const unreadSection = unreadByMsg.length === 0 ? '' : `
      <h2>3. 미확인자 명단</h2>
      <p class="muted small">아래 인원은 발송된 안전 알림을 확인하지 않은 상태입니다.</p>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:36px">No</th>
            <th style="width:140px">발송시각</th>
            <th>카테고리</th>
            <th>미확인자</th>
            <th style="width:60px">미확인</th>
          </tr>
        </thead>
        <tbody>
          ${unreadByMsg.map((x, i) => `
            <tr>
              <td class="num">${i + 1}</td>
              <td>${x.msg.sentAt.slice(0, 16).replace('T', ' ')}</td>
              <td>${escapeHtml(x.msg.categoryTitle)}</td>
              <td>${x.unread.map((r) => escapeHtml(r.recipientName)).join(', ')}</td>
              <td class="num">${x.unread.length}명</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>안전 사고 예방 알림 현황 — ${todayStr}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Malgun Gothic', '맑은 고딕', sans-serif;
    color: #1f2937;
    font-size: 11pt;
    line-height: 1.5;
    margin: 0;
    padding: 0;
  }
  .doc-head {
    text-align: center;
    border-bottom: 3px solid #0f766e;
    padding-bottom: 14px;
    margin-bottom: 22px;
  }
  .doc-head h1 {
    font-size: 22pt;
    font-weight: 800;
    color: #0f766e;
    margin: 0 0 8px;
    letter-spacing: -0.02em;
  }
  .doc-meta {
    display: flex;
    justify-content: space-between;
    font-size: 10pt;
    color: #475569;
    margin-top: 8px;
  }
  h2 {
    font-size: 13pt;
    font-weight: 800;
    color: #0f172a;
    margin: 22px 0 10px;
    padding-bottom: 4px;
    border-bottom: 2px solid #cbd5e1;
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 8px; }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #f1f5f9;
    font-weight: 700;
    font-size: 10pt;
  }
  td { font-size: 10pt; }
  .info-table td:first-child {
    background: #f8fafc;
    font-weight: 700;
    width: 130px;
  }
  .info-table .sep td { border: 0; padding: 4px 0; }
  /* 현장 정보 통합 표 — 4행 × 3열 (라벨/값 교차) */
  .info-grid {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 14px;
    table-layout: fixed;
  }
  .info-grid td {
    border: 1px solid #cbd5e1;
    padding: 7px 12px;
    vertical-align: middle;
    font-size: 10pt;
    word-break: keep-all;
  }
  .info-grid-label td {
    background: #f1f5f9;
    font-weight: 800;
    font-size: 9.5pt;
    color: #0f172a;
    width: 33.333%;
  }
  .info-grid-value td {
    background: #fff;
    color: #1f2937;
    font-weight: 600;
  }
  .info-grid .site-agent {
    color: #0f766e;
    font-weight: 700;
    margin-left: 4px;
  }
  /* 「1. 개요」 통합 메타 + 표 */
  .overview-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px 22px;
    padding: 8px 12px;
    margin-bottom: 8px;
    background: #f8fafc;
    border-left: 3px solid #0f766e;
    border-radius: 0 4px 4px 0;
    font-size: 9.5pt;
    color: #1f2937;
  }
  .overview-meta strong {
    display: inline-block;
    margin-right: 5px;
    color: #0f172a;
    font-weight: 800;
  }
  .overview-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 14px;
  }
  .overview-table th {
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    padding: 7px 10px;
    font-size: 9.5pt;
    font-weight: 800;
    color: #0f172a;
    text-align: left;
  }
  .overview-table td {
    border: 1px solid #cbd5e1;
    padding: 7px 10px;
    font-size: 9.5pt;
    color: #1f2937;
    vertical-align: middle;
  }
  .overview-table .ov-name { font-weight: 700; color: #0f172a; word-break: keep-all; }
  .overview-table .ov-cats { color: #475569; font-size: 9pt; }
  .overview-table tr:nth-child(even) td { background: #fafbfc; }
  /* 현장 정보 — 4줄 리스트 (주소·전화 제거) */
  .info-block {
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 10px;
  }
  .info-meta {
    display: flex;
    gap: 18px;
    padding-bottom: 8px;
    border-bottom: 1px dashed #cbd5e1;
    font-size: 10pt;
    color: #475569;
  }
  .info-meta strong {
    display: inline-block;
    margin-right: 6px;
    color: #0f172a;
    font-weight: 700;
  }
  .site-list {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .site-list li {
    padding: 4px 0;
    font-size: 10.5pt;
    color: #1f2937;
    border-bottom: 1px dotted #e2e8f0;
  }
  .site-list li:last-child { border-bottom: 0; }
  .site-label { color: #475569; font-weight: 700; margin-right: 4px; }
  .site-agent { color: #0f766e; font-weight: 600; margin-left: 4px; }
  /* 카테고리 그리드 — 6열 압축 배치 */
  .cat-grid-title {
    margin: 16px 0 8px;
    font-size: 11pt;
    color: #475569;
    font-weight: 700;
  }
  .cat-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    margin-bottom: 14px;
  }
  .cat-grid-empty {
    padding: 16px;
    text-align: center;
    border: 1px dashed #cbd5e1;
    border-radius: 6px;
  }
  .cat-cell {
    padding: 8px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 5px;
    background: #f8fafc;
    text-align: center;
    min-height: 60px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .cat-cell-title {
    font-size: 9.5pt;
    font-weight: 700;
    color: #0f172a;
    line-height: 1.3;
    word-break: keep-all;
  }
  .cat-cell-meta {
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 9pt;
  }
  .cat-cell-count {
    font-weight: 800;
    color: #0f766e;
    font-variant-numeric: tabular-nums;
  }
  .cat-cell-sev { font-size: 8.5pt; color: #64748b; }
  .cat-cell--critical { background: #fef2f2; border-color: #fca5a5; }
  .cat-cell--critical .cat-cell-sev { color: #b91c1c; font-weight: 700; }
  .cat-cell--caution { background: #fffbeb; border-color: #fcd34d; }
  .cat-cell--caution .cat-cell-sev { color: #b45309; font-weight: 700; }
  .cat-cell--normal { background: #f0fdfa; border-color: #99f6e4; }
  .summary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 0 0 14px;
  }
  .kpi {
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    padding: 10px 12px;
    background: #f8fafc;
  }
  .kpi-label { font-size: 10pt; color: #64748b; font-weight: 600; }
  .kpi-value { font-size: 16pt; font-weight: 800; color: #0f766e; margin-top: 2px; }
  .kpi-value em { font-style: normal; font-size: 10pt; color: #475569; margin-left: 3px; }
  .data-table th { font-size: 9.5pt; }
  .data-table td { font-size: 9.5pt; }
  .data-table .msg { max-width: 220px; word-break: break-word; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #94a3b8; }
  .small { font-size: 9pt; }
  .footnote {
    margin-top: 30px;
    padding-top: 14px;
    border-top: 1px dashed #cbd5e1;
    font-size: 9pt;
    color: #64748b;
    display: flex;
    justify-content: space-between;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="doc-head">
    <h1>안전 사고 예방 알림 현황</h1>
    <div class="doc-meta">
      <span>보고 기간: <strong>${periodLabel}</strong></span>
      <span>발행일: <strong>${todayStr}</strong></span>
    </div>
  </div>

  <h2>1. 개요</h2>
  <div class="overview-meta">
    <span><strong>회사명</strong> ${escapeHtml(user?.companyName ?? '—')}</span>
    <span><strong>발행자</strong> ${escapeHtml(user?.name ?? '—')} <span class="muted small">${escapeHtml(user?.role ?? '')}</span></span>
    <span><strong>총 발송</strong> ${filteredMessages.length}건</span>
    <span><strong>평균 확인율</strong> ${readRate}%</span>
    <span><strong>심각도</strong> 경고 ${sevCount.CRITICAL}·주의 ${sevCount.CAUTION}·일반 ${sevCount.NORMAL}</span>
  </div>
  <table class="overview-table">
    <thead>
      <tr>
        <th>구분</th>
        <th style="width:80px">발송 건수</th>
        <th style="width:70px">확인율</th>
        <th style="width:90px">발송채널</th>
        <th style="width:80px">발송자</th>
        <th>주요 내용</th>
      </tr>
    </thead>
    <tbody>
      ${
        overviewRows.length === 0
          ? `<tr><td colspan="6" class="muted">대상 현장이 없습니다.</td></tr>`
          : overviewRows
              .map(
                (r) => `
        <tr>
          <td class="ov-name">${escapeHtml(r.name)}</td>
          <td class="num">${r.count}건</td>
          <td class="num">${r.rate}%</td>
          <td>${escapeHtml(r.channels)}</td>
          <td>${escapeHtml(r.agent)}</td>
          <td class="ov-cats">${escapeHtml(r.topCats)}</td>
        </tr>
      `,
              )
              .join('')
      }
    </tbody>
  </table>

  <h2>2. 세부 발송 이력</h2>
  <table class="data-table">
    <thead>
      <tr>
        <th style="width:36px">No</th>
        <th style="width:140px">발송시각</th>
        <th style="width:140px">카테고리</th>
        <th>본문</th>
        <th>수신자 / 채널</th>
        <th style="width:80px">확인율</th>
      </tr>
    </thead>
    <tbody>
      ${detailRows}
    </tbody>
  </table>

  ${unreadSection}

  <div class="footnote">
    <span>본 보고서는 ${escapeHtml(user?.companyName ?? '')} 안전관리 시스템에서 자동 생성되었습니다.</span>
    <span>BodaPass · 보다패스</span>
  </div>

  <script>
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 250);
    });
  </script>
</body>
</html>`;

    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) {
      window.alert('팝업이 차단되었습니다.\n브라우저 주소창 우측의 팝업 차단 아이콘을 눌러 허용해주세요.');
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  return (
    <div className="safety">
      <PageHeader
        title="안전관리"
        subtitle="안전 알림 발송 이력 · 카테고리 · 감사 로그 · 사고 대응 출력"
        actions={
          <div className="safety__actions">
            {autoSendSnap.autoSendEnabled && (autoSendSnap.targetForeman || autoSendSnap.targetWorker) && (
              <button
                type="button"
                className="safety__auto-badge"
                title="자동 발송 설정 — 클릭하면 설정창이 열립니다."
                onClick={() => setSettingsOpen(true)}
              >
                <span className="safety__auto-badge-dot" aria-hidden />
                {autoSendSnap.targetForeman && autoSendSnap.targetWorker
                  ? '반장·작업자 자동 문자 발송 중'
                  : autoSendSnap.targetForeman
                    ? '반장 자동 문자 발송 중'
                    : '작업자 자동 문자 발송 중'}
              </button>
            )}
            <button type="button" className="safety__btn safety__btn--ghost" onClick={() => setSettingsOpen(true)}>
              설정
            </button>
            <button type="button" className="safety__btn safety__btn--ghost" onClick={printReport}>
              보고서 인쇄
            </button>
            <button type="button" className="safety__btn safety__btn--ghost" onClick={exportCsv}>
              CSV 내보내기
            </button>
            <button type="button" className="safety__btn safety__btn--primary" onClick={() => openComposer()}>
              + 새 발송
            </button>
          </div>
        }
      />

      {/* 오늘 추천 — 공종 기반 + 기상 + 출퇴근 연동 (3가지 차별 한 줄) */}
      {recommendations && recommendations.workingToday > 0 && (
        <RecommendStrip
          rec={recommendations}
          onPick={(cat) =>
            openComposer({
              categoryId: cat.id,
              categoryTitle: cat.title,
              message: cat.defaultMsg,
              severity: cat.severity,
            })
          }
        />
      )}

      {/* 기상특보 안전공지 제안 — 7일 예보에서 강풍/호우/대설/뇌우/한파 자동 감지 */}
      <WeatherAlertBanner onSent={() => reload()} />

      {/* 탭 */}
      <div className="safety__tabs" role="tablist">
        {(
          [
            ['OUTBOX', '발송함', filteredMessages.length],
            ['CATEGORIES', '카테고리', categories.length],
            ['STATS', '통계', stats?.totalCount ?? 0],
            ['AUDIT', '감사 로그', audit.length],
          ] as Array<[TabKey, string, number]>
        ).map(([k, label, count]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={'safety__tab' + (tab === k ? ' is-active' : '')}
            onClick={() => setTab(k)}
          >
            <span className="safety__tab-label">{label}</span>
            <span className="safety__tab-count">{count}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <p className="safety__loading">불러오는 중…</p>
      ) : (
        <>
          {tab === 'OUTBOX' && (
            <OutboxTab
              messages={filteredMessages}
              sites={sites}
              categories={categories}
              filterFrom={filterFrom} setFilterFrom={setFilterFrom}
              filterTo={filterTo} setFilterTo={setFilterTo}
              filterSite={filterSite} setFilterSite={setFilterSite}
              filterCategory={filterCategory} setFilterCategory={setFilterCategory}
              filterQ={filterQ} setFilterQ={setFilterQ}
              weekModeActive={weekModeActive}
              onApply={applyFilters}
              onReset={resetFilters}
              onQuick={setQuickPeriod}
              totalCount={messages.length}
              onRowClick={(m) => setDetailOpen(m)}
              onResend={async (m) => {
                if (!confirm(`미확인자에게 재발송하시겠습니까?\n\n${m.categoryTitle}\n미확인 ${(m.readReceipts ?? []).filter((r) => !r.readAt).length}명`)) return;
                await safetyApi.resendUnread({ messageId: m.id });
                await reload();
              }}
            />
          )}
          {tab === 'CATEGORIES' && <CategoriesTab categories={categories} />}
          {tab === 'STATS' && stats && <StatsTab stats={stats} />}
          {tab === 'AUDIT' && <AuditTab entries={audit} />}
        </>
      )}

      {composerOpen && (
        <ComposerDialog
          sites={sites}
          categories={categories}
          initial={composerInitial}
          onClose={() => setComposerOpen(false)}
          onSent={async () => {
            setComposerOpen(false);
            await reload();
          }}
        />
      )}

      {detailOpen && (
        <MessageDetailDialog
          message={detailOpen}
          onClose={() => setDetailOpen(null)}
          onResend={async () => {
            await safetyApi.resendUnread({ messageId: detailOpen.id });
            await reload();
            setDetailOpen(null);
          }}
        />
      )}

      {settingsOpen && (
        <SafetySettingsDialog
          categories={categories}
          workingTodayCount={recommendations?.workingToday ?? 0}
          onClose={() => {
            setSettingsOpen(false);
            setAutoSendSnap(loadSafetySettings());
          }}
        />
      )}
    </div>
  );
}

/* ───────── 오늘 추천 스트립 ───────── */

function RecommendStrip({
  rec,
  onPick,
}: {
  rec: TodayRecommendationsResponse;
  onPick: (cat: SafetyCategory) => void;
}) {
  return (
    <div className="safety__recommend">
      <div className="safety__recommend-head">
        <strong>오늘 추천 메시지</strong>
        <span className="safety__recommend-meta">
          오늘 출근 <strong>{rec.workingToday}명</strong>
          {' · '}
          주요 직종:{' '}
          {rec.rolesDistribution.slice(0, 4).map((r, i) => (
            <span key={r.role} className="safety__rec-role">
              {i > 0 && ', '}
              {r.role} <em>{r.count}</em>
            </span>
          ))}
          {rec.weather && rec.weather.condition !== 'NORMAL' && (
            <Tooltip
              tone={
                rec.weather.condition === 'HEAT' || rec.weather.condition === 'COLD'
                  ? 'danger'
                  : 'warning'
              }
              title={`${weatherIcon(rec.weather.condition)} ${rec.weather.label}`}
              body={weatherAdvice(rec.weather.condition)}
            >
              <span className="safety__rec-weather">· {rec.weather.label}</span>
            </Tooltip>
          )}
        </span>
      </div>
      {rec.recommendations.length === 0 ? (
        <p className="safety__recommend-empty">오늘 출근자 직종에 맞는 추천이 없습니다.</p>
      ) : (
        <div className="safety__recommend-grid">
          {rec.recommendations.map((r) => (
            <button
              key={r.category.id}
              type="button"
              className="safety__recommend-card"
              onClick={() => onPick(r.category)}
              title="클릭 — 이 메시지로 새 발송"
            >
              <span className="safety__recommend-icon">{r.category.icon}</span>
              <span className="safety__recommend-body">
                <strong>{r.category.title}</strong>
                <em>
                  {r.matchedWorkers}명 매칭 · {r.matchedRoles.slice(0, 2).join(', ')}
                  {r.matchedRoles.length > 2 ? ' 외' : ''}
                </em>
              </span>
              <SeverityBadge level={r.category.severity} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────── 발송함 ───────── */

function OutboxTab(props: {
  messages: SafetyMessage[];
  sites: Site[];
  categories: SafetyCategory[];
  filterFrom: string; setFilterFrom: (v: string) => void;
  filterTo: string; setFilterTo: (v: string) => void;
  filterSite: string; setFilterSite: (v: string) => void;
  filterCategory: string; setFilterCategory: (v: string) => void;
  filterQ: string; setFilterQ: (v: string) => void;
  weekModeActive: boolean;
  onApply: () => void;
  onReset: () => void;
  onQuick: (kind: 'TODAY' | 'WEEK' | 'MONTH' | 'ALL') => void;
  totalCount: number;
  onRowClick: (m: SafetyMessage) => void;
  onResend: (m: SafetyMessage) => void | Promise<void>;
}) {
  const {
    messages, sites, categories,
    filterFrom, setFilterFrom, filterTo, setFilterTo,
    filterSite, setFilterSite, filterCategory, setFilterCategory,
    filterQ, setFilterQ, weekModeActive, onApply, onReset, onQuick,
    totalCount, onRowClick, onResend,
  } = props;

  // 어떤 빠른 기간이 활성인지 판별 (시각 강조용)
  const todayStr = new Date().toISOString().slice(0, 10);
  const isQuickToday = filterFrom === todayStr && filterTo === todayStr;
  const isQuickMonth = filterFrom === todayStr.slice(0, 7) + '-01' && filterTo === todayStr;
  const isQuickAll = !filterFrom && !filterTo;
  // 이번 주 활성 여부 — 부모 상태(weekModeActive)에 위임. 이로써 「이번 주」 안에서
  // 특정 요일을 클릭해 from===to 가 되어도 「이번 주」 강조가 유지됨.
  const isQuickWeek = weekModeActive;

  return (
    <div className="safety__panel">
      <div className="safety__filter card">
        {/* 1행: 빠른 기간 토글 */}
        <div className="safety__quick">
          <span className="safety__quick-label">기간</span>
          <button type="button" className={'safety__quick-btn' + (isQuickToday ? ' is-active' : '')} onClick={() => onQuick('TODAY')}>오늘</button>
          <button type="button" className={'safety__quick-btn' + (isQuickWeek ? ' is-active' : '')} onClick={() => onQuick('WEEK')}>이번 주</button>
          {isQuickWeek && (
            <WeekDayChips
              filterFrom={filterFrom}
              filterTo={filterTo}
              setFilterFrom={setFilterFrom}
              setFilterTo={setFilterTo}
            />
          )}
          <button type="button" className={'safety__quick-btn' + (isQuickMonth ? ' is-active' : '')} onClick={() => onQuick('MONTH')}>이번 달</button>
          <button type="button" className={'safety__quick-btn' + (isQuickAll ? ' is-active' : '')} onClick={() => onQuick('ALL')}>전체</button>
        </div>
        {/* 2행: 직접 입력 + 조회/초기화 */}
        <div className="safety__filter-grid">
          <label><span>시작일</span><MacDatePicker
              value={filterFrom}
              onChange={(v) => setFilterFrom(v)}
            /></label>
          <label><span>종료일</span><MacDatePicker
              value={filterTo}
              onChange={(v) => setFilterTo(v)}
            /></label>
          <label>
            <span>현장</span>
            <MacSelect
              value={filterSite}
              onChange={(v) => setFilterSite(v)}
              options={[{ value: "", label: '전체' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
            />
          </label>
          <label>
            <span>카테고리</span>
            <MacSelect
              value={filterCategory}
              onChange={(v) => setFilterCategory(v)}
              options={[{ value: "", label: '전체' }, ...categories.map((c) => ({ value: c.id, label: <>{c.icon} {c.title}</> }))]}
            />
          </label>
          <label className="safety__filter-q">
            <span>검색</span>
            <input
              type="text"
              placeholder="본문·수신자명 검색"
              value={filterQ}
              onChange={(e) => setFilterQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onApply(); }}
            />
          </label>
        </div>
        <div className="safety__filter-actions">
          <span className="safety__filter-summary">{messages.length} / {totalCount} 건</span>
          <button type="button" className="safety__btn safety__btn--ghost" onClick={onReset}>초기화</button>
          <button type="button" className="safety__btn safety__btn--primary" onClick={onApply}>조회하기</button>
        </div>
      </div>

      <div className="card safety__table-wrap">
        <table className="safety__table">
          <thead>
            <tr>
              <th>발송시각</th>
              <th>카테고리</th>
              <th>심각도</th>
              <th>본문</th>
              <th>대상</th>
              <th>확인</th>
              <th>채널</th>
              <th>발송자</th>
              <th>결과</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {messages.length === 0 ? (
              <tr><td colSpan={10} className="safety__empty">조건에 맞는 발송 이력이 없습니다.</td></tr>
            ) : messages.map((m) => {
              const total = (m.readReceipts ?? []).length;
              const read = (m.readReceipts ?? []).filter((r) => r.readAt).length;
              const unread = total - read;
              return (
                <tr key={m.id} className="safety__row" onClick={() => onRowClick(m)}>
                  <td className="safety__mono">{m.sentAt.slice(0, 16).replace('T', ' ')}</td>
                  <td>{m.categoryTitle}</td>
                  <td><SeverityBadge level={m.severity} /></td>
                  <td className="safety__msg" title={m.message}>{m.message}</td>
                  <td className="safety__audience">
                    <strong>{audienceLabel(m.audienceFilter)}</strong>
                    <em>{m.recipients.length}명</em>
                  </td>
                  <td>
                    <ReadProgress read={read} total={total} />
                  </td>
                  <td className="safety__channels">
                    {m.channels.map((c) => (
                      <span key={c} className={'safety__chip safety__chip--' + c.toLowerCase()}>
                        {c === 'SMS' ? 'SMS' : 'APP'}
                      </span>
                    ))}
                  </td>
                  <td>{m.sentBy.name}</td>
                  <td><StatusBadge status={m.status} /></td>
                  <td className="safety__row-action" onClick={(e) => e.stopPropagation()}>
                    {unread > 0 ? (
                      <button
                        type="button"
                        className="safety__btn safety__btn--xs safety__btn--ghost"
                        onClick={() => onResend(m)}
                        title={`미확인 ${unread}명에게 재발송`}
                      >
                        ↺ 재발송
                      </button>
                    ) : (
                      <span className="safety__row-done">✓ 완료</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReadProgress({ read, total }: { read: number; total: number }) {
  if (total === 0) return <span className="safety__read-none">—</span>;
  const ratio = read / total;
  const pct = Math.round(ratio * 100);
  const cls = ratio >= 1 ? 'is-full' : ratio >= 0.7 ? 'is-good' : ratio >= 0.4 ? 'is-mid' : 'is-low';
  return (
    <div className={'safety__read ' + cls} title={`확인 ${read} / 총 ${total} (${pct}%)`}>
      <span className="safety__read-bar"><span className="safety__read-fill" style={{ width: pct + '%' }} /></span>
      <strong>{read}/{total}</strong>
    </div>
  );
}

/* ───────── 카테고리 ───────── */

function CategoriesTab({ categories }: { categories: SafetyCategory[] }) {
  return (
    <div className="safety__panel">
      <div className="safety__cat-grid">
        {categories.map((c) => (
          <div key={c.id} className={'safety__cat-card' + (c.isStandard ? ' is-standard' : '')}>
            <div className="safety__cat-head">
              <span className="safety__cat-icon">{c.icon}</span>
              <strong className="safety__cat-title">{c.title}</strong>
              <SeverityBadge level={c.severity} />
            </div>
            <p className="safety__cat-msg">{c.defaultMsg}</p>
            {(c.appliedRoles && c.appliedRoles.length > 0) && (
              <div className="safety__cat-roles">
                <span className="safety__cat-roles-label">적용 공종:</span>
                {c.appliedRoles.map((r) => <span key={r} className="safety__role-chip">{r}</span>)}
              </div>
            )}
            <div className="safety__cat-foot">
              {c.isStandard ? (
                <span className="safety__cat-flag">표준 (수정 불가)</span>              ) : (
                <>
                  <button type="button" className="safety__btn safety__btn--xs safety__btn--ghost" disabled>수정</button>
                  <button type="button" className="safety__btn safety__btn--xs safety__btn--danger" disabled>삭제</button>
                </>
              )}
            </div>
          </div>
        ))}
        <div className="safety__cat-card safety__cat-card--add">
          <button type="button" className="safety__cat-add" disabled>
            <span style={{ fontSize: 24 }}>＋</span>
            <span>사용자 정의 카테고리 추가</span>
            <span className="safety__cat-add-hint">(다음 단계에서 활성화)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── 통계 ───────── */

function StatsTab({ stats }: { stats: SafetyStats }) {
  const maxByDate = Math.max(1, ...stats.byDate.map((d) => d.count));
  const maxByCat = Math.max(1, ...stats.byCategory.map((c) => c.count));
  return (
    <div className="safety__panel">
      <div className="safety__stat-kpis">
        <KpiTile label="이달 발송" value={stats.monthCount} unit="건" tone="primary" />
        <KpiTile label="누적 발송" value={stats.totalCount} unit="건" tone="neutral" />
        <KpiTile label="문자(SMS)" value={stats.byChannel.find((c) => c.channel === 'SMS')?.count ?? 0} unit="건" tone="sky" />
        <KpiTile label="앱 알림" value={stats.byChannel.find((c) => c.channel === 'APP')?.count ?? 0} unit="건" tone="amber" />
      </div>
      <div className="safety__stat-grid">
        <div className="card safety__stat-card">
          <h3 className="safety__stat-title">카테고리별 발송 (Top {stats.byCategory.length})</h3>
          <ul className="safety__stat-bars">
            {stats.byCategory.map((c) => (
              <li key={c.categoryId ?? '__custom'}>
                <span className="safety__stat-bar-label">{c.categoryTitle}</span>
                <span className="safety__stat-bar-track">
                  <span className="safety__stat-bar-fill" style={{ width: `${(c.count / maxByCat) * 100}%` }} />
                </span>
                <strong>{c.count}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div className="card safety__stat-card">
          <h3 className="safety__stat-title">최근 30일 일자별 발송</h3>
          <div className="safety__stat-spark">
            {stats.byDate.map((d) => (
              <span
                key={d.date}
                className="safety__stat-spark-bar"
                title={`${d.date} · ${d.count}건`}
                style={{ height: `${(d.count / maxByDate) * 100}%` }}
              />
            ))}
          </div>
          <div className="safety__stat-spark-axis">
            <span>{stats.byDate[0]?.date.slice(5)}</span>
            <span>{stats.byDate[stats.byDate.length - 1]?.date.slice(5)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── 감사 로그 ───────── */

function AuditTab({ entries }: { entries: SafetyAudit[] }) {
  return (
    <div className="safety__panel">
      <div className="card safety__audit">
        <div className="safety__audit-head">
          <strong>감사 로그</strong>
          <span className="safety__audit-meta">총 {entries.length} 건 · 추가만 가능 (수정·삭제 불가)</span>
        </div>
        <ul className="safety__audit-list">
          {entries.length === 0 ? (
            <li className="safety__audit-empty">감사 로그가 비어 있습니다.</li>
          ) : entries.map((e) => (
            <li key={e.id} className="safety__audit-item">
              <span className="safety__audit-time">{e.performedAt.slice(0, 16).replace('T', ' ')}</span>
              <span className={'safety__audit-type safety__audit-type--' + e.type.toLowerCase()}>
                {auditTypeLabel(e.type)}
              </span>
              <span className="safety__audit-summary">{e.summary}</span>
              <span className="safety__audit-by">{e.performedBy.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ───────── 신규 발송 다이얼로그 ───────── */

function ComposerDialog({
  sites,
  categories,
  initial,
  onClose,
  onSent,
}: {
  sites: Site[];
  categories: SafetyCategory[];
  initial: { categoryId: string | null; categoryTitle: string; message: string; severity: 'NORMAL' | 'CAUTION' | 'CRITICAL' } | null;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
  const [message, setMessage] = useState(initial?.message ?? '');
  const [severity, setSeverity] = useState<'NORMAL' | 'CAUTION' | 'CRITICAL'>(initial?.severity ?? 'NORMAL');
  const [audience, setAudience] = useState<SafetyAudienceFilter>('WORKING_TODAY');
  const [siteId, setSiteId] = useState<string>('ALL');
  const [channels, setChannels] = useState<SafetyChannel[]>(['SMS', 'APP']);
  const [sending, setSending] = useState(false);

  const cat = categories.find((c) => c.id === categoryId);
  const categoryTitle = cat?.title ?? initial?.categoryTitle ?? '직접 입력';

  function pickCategory(c: SafetyCategory) {
    setCategoryId(c.id);
    setMessage(c.defaultMsg);
    setSeverity(c.severity);
  }
  function toggleChannel(c: SafetyChannel) {
    setChannels((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  async function handleSend() {
    if (!message.trim()) return;
    if (channels.length === 0) return;
    setSending(true);
    try {
      await safetyApi.sendMessage({
        categoryId,
        categoryTitle,
        message: message.trim(),
        severity,
        audienceFilter: audience,
        siteId,
        channels,
      });
      await onSent();
    } finally {
      setSending(false);
    }
  }

  const canSend = message.trim().length > 0 && channels.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="새 안전 알림 발송"
      width={580}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="safety__btn safety__btn--ghost" onClick={onClose} disabled={sending}>취소</button>
          <button type="button" className="safety__btn safety__btn--primary" onClick={handleSend} disabled={!canSend || sending}>
            {sending ? '발송 중…' : '발송'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <p className="safety__compose-label">카테고리 선택</p>
          <div className="safety__compose-cats">
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={'safety__compose-cat' + (categoryId === c.id ? ' is-active' : '')}
                onClick={() => pickCategory(c)}
                title={c.defaultMsg}
              >
                <span>{c.icon}</span>
                <strong>{c.title}</strong>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="safety__compose-label">메시지 본문</p>
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="카테고리를 선택하거나 직접 입력하세요."
            className="safety__compose-textarea"
          />
        </div>

        <div className="safety__compose-row">
          <div>
            <p className="safety__compose-label">수신 대상 (출퇴근 연동)</p>
            <div className="safety__audience-radio">
              {(
                [
                  ['WORKING_TODAY', '🚶 오늘 출근자만', '비용 절감 + 정확'],
                  ['ALL_REGISTERED', '👥 등록 전체', '모든 팀원'],
                ] as Array<[SafetyAudienceFilter, string, string]>
              ).map(([v, label, hint]) => (
                <label key={v} className={'safety__audience-opt' + (audience === v ? ' is-active' : '')}>
                  <input type="radio" name="audience" value={v} checked={audience === v} onChange={() => setAudience(v)} />
                  <span>
                    <strong>{label}</strong>
                    <em>{hint}</em>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="safety__compose-label">현장</p>
            <MacSelect
              value={siteId}
              onChange={(v) => setSiteId(v)}
              className="safety__compose-select"
              options={[{ value: "ALL", label: '전체 현장' }, ...sites.filter((s) => s.status !== 'COMPLETED').map((s) => (
                ({ value: s.id, label: s.name })
              ))]}
            />
          </div>
        </div>

        <div>
          <p className="safety__compose-label">발송 채널</p>
          <div className="safety__channel-row">
            <button type="button" className={'safety__channel-pill' + (channels.includes('SMS') ? ' is-on' : '')} onClick={() => toggleChannel('SMS')}>
              {channels.includes('SMS') ? '✓ ' : ''}문자(SMS)
            </button>
            <button type="button" className={'safety__channel-pill' + (channels.includes('APP') ? ' is-on' : '')} onClick={() => toggleChannel('APP')}>
              {channels.includes('APP') ? '✓ ' : ''}앱 알림
            </button>
          </div>
          {channels.length === 0 && <p className="safety__compose-warn">발송 채널을 최소 하나 이상 선택하세요.</p>}
        </div>
      </div>
    </Modal>
  );
}

/* ───────── 메시지 상세 다이얼로그 ───────── */

function MessageDetailDialog({
  message,
  onClose,
  onResend,
}: {
  message: SafetyMessage;
  onClose: () => void;
  onResend: () => void | Promise<void>;
}) {
  const total = (message.readReceipts ?? []).length;
  const read = (message.readReceipts ?? []).filter((r) => r.readAt).length;
  const unread = total - read;
  const canResend = unread > 0 && (message.deliveryAttempts ?? []).length < 4;

  return (
    <Modal
      open
      onClose={onClose}
      title={`📨 ${message.categoryTitle}`}
      subtitle={`${message.sentAt.slice(0, 16).replace('T', ' ')} · ${message.sentBy.name} 발송`}
      width={620}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="safety__btn safety__btn--ghost" onClick={onClose}>닫기</button>
          {canResend && (
            <button type="button" className="safety__btn safety__btn--primary" onClick={onResend}>
              ↺ 미확인자 {unread}명 재발송
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>        <div className="safety__detail-meta">
          <span><SeverityBadge level={message.severity} /></span>
          <span><StatusBadge status={message.status} /></span>
          <span className="safety__detail-meta-tag">{audienceLabel(message.audienceFilter)}</span>
          {message.channels.map((c) => (
            <span key={c} className={'safety__chip safety__chip--' + c.toLowerCase()}>
              {c === 'SMS' ? 'SMS' : 'APP'}
            </span>
          ))}
        </div>

        <div className="safety__detail-msg-card">{message.message}</div>

        <div>
          <strong className="safety__detail-h">수신자별 확인 상태 ({read}/{total})</strong>
          <ReadProgress read={read} total={total} />
          <ul className="safety__detail-recipients">
            {message.recipients.map((r) => {
              const rr = message.readReceipts?.find((x) => x.recipientId === r.id);
              const isRead = !!rr?.readAt;
              return (
                <li key={r.id} className={isRead ? 'is-read' : 'is-unread'}>
                  <span className="safety__detail-r-status">{isRead ? '✓' : '○'}</span>
                  <strong>{r.name}</strong>
                  <em>{r.siteName ?? ''}</em>
                  <span className="safety__detail-r-time">
                    {isRead
                      ? `${rr!.readAt!.slice(11, 16)} · ${rr!.via === 'APP' ? '앱 확인' : rr!.via === 'REPLY' ? 'SMS 회신' : '반장 대신 확인'}`
                      : '미확인'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {(message.deliveryAttempts ?? []).length > 0 && (
          <div>
            <strong className="safety__detail-h">발송 이력 ({message.deliveryAttempts.length}회)</strong>
            <ul className="safety__detail-attempts">
              {message.deliveryAttempts.map((a) => (
                <li key={a.attempt}>
                  <span className="safety__detail-att-num">{a.attempt}차</span>
                  <span className="safety__detail-att-time">{a.at.slice(0, 16).replace('T', ' ')}</span>
                  <span className="safety__detail-att-target">{a.targetCount}명 → 미확인 {a.unreadCount}명</span>
                  <span className="safety__detail-att-by">
                    {a.triggeredBy === 'system' ? '자동' : a.triggeredBy.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────── 공용 ───────── */

function audienceLabel(a: SafetyAudienceFilter): string {
  switch (a) {
    case 'ALL_REGISTERED': return '등록 전체';
    case 'WORKING_TODAY':  return '오늘 출근자';
    case 'BY_FOREMAN':     return '반장 담당';
    case 'BY_ROLE':        return '직종';
    case 'CUSTOM':         return '직접 선택';
    default: return a;
  }
}

function auditTypeLabel(t: SafetyAudit['type']): string {
  switch (t) {
    case 'SEND_MESSAGE': return '발송';
    case 'RESEND_UNREAD': return '재발송';
    case 'CREATE_CATEGORY': return '카테고리 추가';
    case 'UPDATE_CATEGORY': return '카테고리 수정';
    case 'DELETE_CATEGORY': return '카테고리 삭제';
    case 'EXPORT_LOG': return '내보내기';
    default: return t;
  }
}

function SeverityBadge({ level }: { level: 'NORMAL' | 'CAUTION' | 'CRITICAL' }) {
  const map = {
    NORMAL: { label: '일반', cls: 'is-normal' },
    CAUTION: { label: '주의', cls: 'is-caution' },
    CRITICAL: { label: '경고', cls: 'is-critical' },
  } as const;
  const { label, cls } = map[level] ?? map.NORMAL;
  return <span className={'safety__sev ' + cls}>{label}</span>;
}

function StatusBadge({ status }: { status: 'SENT' | 'PARTIAL' | 'FAILED' }) {
  const map = {
    SENT: { label: '✓ 발송', cls: 'is-sent' },
    PARTIAL: { label: '△ 일부', cls: 'is-partial' },
    FAILED: { label: '✕ 실패', cls: 'is-failed' },
  } as const;
  const { label, cls } = map[status] ?? map.SENT;
  return <span className={'safety__status ' + cls}>{label}</span>;
}

function KpiTile({ label, value, unit, tone }: { label: string; value: number; unit: string; tone: 'primary' | 'neutral' | 'sky' | 'amber' }) {
  return (
    <div className={'safety__kpi safety__kpi--' + tone}>
      <span className="safety__kpi-label">{label}</span>
      <span className="safety__kpi-value">{value.toLocaleString()}<em>{unit}</em></span>
    </div>
  );
}

/* ───────── 발송 설정 ───────── */

interface SafetySettings {
  autoSendEnabled: boolean;
  targetForeman: boolean;
  targetWorker: boolean;
  targetByRole: boolean;
  /** 시간대별 발송 on/off — 켜진 시간대만 자동 발송 */
  enableTbm: boolean;
  enableLunch: boolean;
  enableClose: boolean;
  scheduleTbm: string;
  scheduleLunch: string;
  scheduleClose: string;
  customMessages: Record<string, string>;
}

const SAFETY_SETTINGS_KEY = 'bodapass.safety.settings.v1';

type SettingsTabKey = 'AUTO' | 'TARGET' | 'TIME' | 'CONTENT';

const SETTINGS_TABS: Array<[SettingsTabKey, string]> = [
  ['AUTO', '자동 발송'],
  ['TARGET', '발송 대상'],
  ['TIME', '발송 시간'],
  ['CONTENT', '발송 내용'],
];

const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  autoSendEnabled: false,
  targetForeman: true,
  targetWorker: true,
  targetByRole: true,
  enableTbm: true,
  enableLunch: false,
  enableClose: true,
  scheduleTbm: '07:00',
  scheduleLunch: '12:00',
  scheduleClose: '17:30',
  customMessages: {},
};

function loadSafetySettings(): SafetySettings {
  try {
    const raw = localStorage.getItem(SAFETY_SETTINGS_KEY);
    if (!raw) return DEFAULT_SAFETY_SETTINGS;
    return { ...DEFAULT_SAFETY_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SAFETY_SETTINGS;
  }
}

function saveSafetySettings(s: SafetySettings) {
  try {
    localStorage.setItem(SAFETY_SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    console.error('설정 저장 실패', e);
  }
}

function SafetySettingsDialog(props: {
  categories: SafetyCategory[];
  workingTodayCount: number;
  onClose: () => void;
}) {
  const { categories, workingTodayCount, onClose } = props;
  const [s, setS] = useState<SafetySettings>(loadSafetySettings);
  const [tab, setTab] = useState<SettingsTabKey>('AUTO');
  const [editingCat, setEditingCat] = useState<string | null>(null);
  /** 자동 발송 미리보기용 인원수 — 모달 마운트 시 1회 fetch */
  const [recipientStats, setRecipientStats] = useState<{
    foremanCount: number;
    workerCount: number;
    activeWorkerCount: number;
  }>({ foremanCount: 0, workerCount: 0, activeWorkerCount: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fr, mr] = await Promise.all([
          siteApi.listForemen(),
          teamApi.list({}),
        ]);
        if (cancelled) return;
        const foremanCount = fr.foremen.filter((f) => f.registered).length;
        const workerCount = mr.members.length;
        const activeWorkerCount = mr.members.filter(
          (m) => !m.leftAt && !!m.contractSigned && m.faceVerified !== false,
        ).length;
        setRecipientStats({ foremanCount, workerCount, activeWorkerCount });
      } catch {
        // 무시 — 0으로 노출
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(k: keyof SafetySettings, v: unknown) {
    setS((prev) => ({ ...prev, [k]: v } as SafetySettings));
  }

  const handleSave = () => {
    saveSafetySettings(s);
    alert('✓ 설정이 저장되었습니다.');
    onClose();
  };

  const resetCategoryMessage = (catId: string) => {
    setS((prev) => {
      const next = { ...prev.customMessages };
      delete next[catId];
      return { ...prev, customMessages: next };
    });
  };

  const tabsBar = SETTINGS_TABS.map((entry) => {
    const k = entry[0];
    const label = entry[1];
    const cls = 'safety__settings-tab' + (tab === k ? ' is-active' : '');
    return (
      <button key={k} type="button" className={cls} onClick={() => setTab(k)}>
        <span>{label}</span>
      </button>
    );
  });

  // 자동 발송 시 예상 수신자 수 — 「발송 대상」 토글 + 등록 인원 기준.
  // (실제 발송 시점에는 출근자만 추려지므로 「예상 N명」 표기)
  const expectedRecipients = (() => {
    const foreman = s.targetForeman ? recipientStats.foremanCount : 0;
    const worker = s.targetWorker ? recipientStats.workerCount : 0;
    const total = foreman + worker;
    // 오늘 출근자 기준 — total과 workingToday 중 작은 값으로 추정 cap
    const expected = workingTodayCount > 0
      ? Math.min(total, workingTodayCount + foreman) // 반장은 출근 무관 발송
      : total;
    return { foreman, worker, total, expected };
  })();

  const renderAuto = () => (
    <div className="safety__settings-panel">
      <div className="safety__settings-row">
        <div className="safety__settings-row-info">
          <strong>자동 발송 활성화</strong>
          <em>설정한 시간에 공종/직종 기반 안전 메시지를 자동으로 발송합니다.</em>
        </div>
        <SafetyToggleSwitch checked={s.autoSendEnabled} onChange={(v) => patch('autoSendEnabled', v)} />
      </div>

      {s.autoSendEnabled ? (
        <>
          <p className="safety__settings-note">
            ✓ 자동 발송이 켜져 있습니다. 「발송 시간」 탭에서 시각을 조정하세요.
          </p>
          <div className="safety__auto-preview">
            <h4>자동 문자 발송 대상 (현재 설정 기준)</h4>
            <ul className="safety__auto-list">
              <li>
                <span className="safety__auto-key">반장</span>
                <span className="safety__auto-val">
                  {s.targetForeman ? (
                    <strong>{recipientStats.foremanCount}명</strong>
                  ) : (
                    <em>발송 안 함</em>
                  )}
                </span>
              </li>
              <li>
                <span className="safety__auto-key">근로자 (등록 인원)</span>
                <span className="safety__auto-val">
                  {s.targetWorker ? (
                    <>
                      <strong>{recipientStats.workerCount}명</strong>
                      {recipientStats.activeWorkerCount > 0 && (
                        <small> · 출근 가능 {recipientStats.activeWorkerCount}명</small>
                      )}
                    </>
                  ) : (
                    <em>발송 안 함</em>
                  )}
                </span>
              </li>
              <li>
                <span className="safety__auto-key">오늘 출근자</span>
                <span className="safety__auto-val">
                  <strong>{workingTodayCount}명</strong>
                  <small> · 발송 시점 기준</small>
                </span>
              </li>
            </ul>
            <p className="safety__auto-summary">
              → 자동 발송 시 <strong>약 {expectedRecipients.expected}명</strong>
              {' '}({expectedRecipients.foreman > 0 && `반장 ${expectedRecipients.foreman}명`}
              {expectedRecipients.foreman > 0 && expectedRecipients.worker > 0 && ' + '}
              {expectedRecipients.worker > 0 && `근로자 ${Math.min(workingTodayCount, expectedRecipients.worker) || expectedRecipients.worker}명`}
              )에게 자동 문자 발송 예정.
            </p>
            <p className="safety__auto-note">
              ※ 「발송 대상」 탭에서 반장/근로자/직종 매칭을 조정할 수 있어요.
              실제 발송 시점에는 「오늘 출근자」 기준으로 자동 추려집니다.
            </p>
          </div>
        </>
      ) : (
        <p className="safety__settings-note">
          ⚠ 자동 발송이 꺼져 있습니다. 모든 메시지는 수동으로만 전송됩니다.
        </p>
      )}
    </div>
  );

  const renderTarget = () => (
    <div className="safety__settings-panel">
      <p className="safety__settings-desc">발송 대상으로 포함할 그룹을 선택합니다. 끄면 자동 발송과 추천에서 제외됩니다.</p>
      <div className="safety__settings-row">
        <div className="safety__settings-row-info">
          <strong>👷‍♂️ 반장</strong>
          <em>반장 그룹에게 안전 메시지를 발송합니다.</em>
        </div>
        <SafetyToggleSwitch checked={s.targetForeman} onChange={(v) => patch('targetForeman', v)} />
      </div>
      <div className="safety__settings-row">
        <div className="safety__settings-row-info">
          <strong>👷 근로자</strong>
          <em>현장 근로자 전체에게 발송합니다.</em>
        </div>
        <SafetyToggleSwitch checked={s.targetWorker} onChange={(v) => patch('targetWorker', v)} />
      </div>
      <div className="safety__settings-row">
        <div className="safety__settings-row-info">
          <strong>🔧 직종별 매칭</strong>
          <em>카테고리의 적용 공종과 일치하는 인원에게만 발송합니다 (정밀도 높음).</em>
        </div>
        <SafetyToggleSwitch checked={s.targetByRole} onChange={(v) => patch('targetByRole', v)} />
      </div>
    </div>
  );

  const renderTime = () => (
    <div className="safety__settings-panel">
      <p className="safety__settings-desc">보내고 싶은 시간대만 선택하세요. 꺼진 시간대는 자동 발송에서 제외됩니다.</p>
      <div className={'safety__settings-time-row' + (s.enableTbm ? ' is-on' : ' is-off')}>
        <SafetyToggleSwitch checked={s.enableTbm} onChange={(v) => patch('enableTbm', v)} />
        <strong>🌅 TBM (작업 전 안전 회의)</strong>
        <input
          type="time"
          value={s.scheduleTbm}
          onChange={(e) => patch('scheduleTbm', e.target.value)}
          disabled={!s.autoSendEnabled || !s.enableTbm}
        />
      </div>
      <div className={'safety__settings-time-row' + (s.enableLunch ? ' is-on' : ' is-off')}>
        <SafetyToggleSwitch checked={s.enableLunch} onChange={(v) => patch('enableLunch', v)} />
        <strong>🍱 점심 시간 안내</strong>
        <input
          type="time"
          value={s.scheduleLunch}
          onChange={(e) => patch('scheduleLunch', e.target.value)}
          disabled={!s.autoSendEnabled || !s.enableLunch}
        />
      </div>
      <div className={'safety__settings-time-row' + (s.enableClose ? ' is-on' : ' is-off')}>
        <SafetyToggleSwitch checked={s.enableClose} onChange={(v) => patch('enableClose', v)} />
        <strong>🌇 퇴근 전 마무리 점검</strong>
        <input
          type="time"
          value={s.scheduleClose}
          onChange={(e) => patch('scheduleClose', e.target.value)}
          disabled={!s.autoSendEnabled || !s.enableClose}
        />
      </div>
      {!s.autoSendEnabled && (
        <p className="safety__settings-note">⚠ 자동 발송이 꺼져 있어 시각을 변경해도 적용되지 않습니다.</p>
      )}
      {s.autoSendEnabled && !s.enableTbm && !s.enableLunch && !s.enableClose && (
        <p className="safety__settings-note">⚠ 모든 시간대가 꺼져 있어 자동 발송이 실행되지 않습니다.</p>
      )}
    </div>
  );

  const renderContent = () => {
    return (
    <div className="safety__settings-panel">
      <p className="safety__settings-desc">카테고리별 기본 본문을 수정합니다. 「기본값 복원」 시 표준 메시지로 돌아갑니다.</p>
      <div className="safety__settings-cat-list">
        {categories.map((c) => {
          const isEditing = editingCat === c.id;
          const customMsg = s.customMessages[c.id];
          const currentMsg = customMsg ?? c.defaultMsg;
          return (
            <div key={c.id} className={'safety__settings-cat-item' + (isEditing ? ' is-editing' : '')}>
              <div className="safety__settings-cat-head">
                <span className="safety__settings-cat-icon">{c.icon}</span>
                <strong className="safety__settings-cat-title">{c.title}</strong>
                {customMsg !== undefined && <span className="safety__settings-cat-flag">사용자 수정</span>}
                <span className="safety__settings-cat-actions">
                  <button type="button" className="safety__btn safety__btn--xs safety__btn--ghost" onClick={() => setEditingCat(isEditing ? null : c.id)}>
                    {isEditing ? '닫기' : '편집'}
                  </button>
                  {customMsg !== undefined && (
                    <button type="button" className="safety__btn safety__btn--xs safety__btn--danger" onClick={() => resetCategoryMessage(c.id)}>
                      기본값
                    </button>
                  )}
                </span>
              </div>
              {isEditing ? (
                <textarea
                  rows={3}
                  value={currentMsg}
                  onChange={(e) => {
                    const next = { ...s.customMessages, [c.id]: e.target.value };
                    patch('customMessages', next);
                  }}
                />
              ) : (
                <p className="safety__settings-cat-msg">{currentMsg}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
    );
  };

  return (
    <Modal open onClose={onClose} title="⚙ 발송 설정" width={800}>
      <div className="safety__settings">
        <div className="safety__settings-tabs" role="tablist">{tabsBar}</div>
        <div className="safety__settings-body">
          {tab === 'AUTO' && renderAuto()}
          {tab === 'TARGET' && renderTarget()}
          {tab === 'TIME' && renderTime()}
          {tab === 'CONTENT' && renderContent()}
        </div>
        <div className="safety__settings-foot">
          <button type="button" className="safety__btn safety__btn--ghost" onClick={onClose}>취소</button>
          <button type="button" className="safety__btn safety__btn--primary" onClick={handleSave}>저장</button>
        </div>
      </div>
    </Modal>
  );
}

function SafetyToggleSwitch(props: { checked: boolean; onChange: (v: boolean) => void }) {
  const { checked, onChange } = props;
  const cls = 'safety__toggle' + (checked ? ' is-on' : '');
  return (
    <button type="button" role="switch" aria-checked={checked} className={cls} onClick={() => onChange(!checked)}>
      <span className="safety__toggle-knob" />
    </button>
  );
}

/* ───────── 날씨 헬퍼 ───────── */

function weatherIcon(c: 'NORMAL' | 'HEAT' | 'COLD' | 'RAIN' | 'WIND'): string {
  switch (c) {
    case 'HEAT': return '☀';
    case 'COLD': return '❄';
    case 'RAIN': return '☂';
    case 'WIND': return '💨';
    default: return '🌤';
  }
}

function weatherAdvice(c: 'NORMAL' | 'HEAT' | 'COLD' | 'RAIN' | 'WIND'): string {
  switch (c) {
    case 'HEAT': return '폭염 — 매시간 10분 휴식 / 그늘·물·소금 비치 / 어지러움 즉시 작업 중지';
    case 'COLD': return '한파 — 보온 작업복·핫팩 지급 / 동상 예방 / 결빙 구간 통제';
    case 'RAIN': return '우천 — 미끄럼 주의 / 전동공구 누전 점검 / 고소작업 금지';
    case 'WIND': return '강풍 — 양중작업 중단 / 외장비계 결속 점검 / 자재 비산 방지';
    default: return '오늘 날씨는 양호합니다';
  }
}

/* ───────── 「이번 주」 활성 시 — 요일 칩 행 (월~일) ─────────
 * 클릭한 요일이 「이번 주」에 속한 그 날짜로 from/to 가 동일하게 설정됨.
 * 같은 요일을 다시 누르면 「이번 주 전체」(월~일)로 복귀.
 * ───────────────────────────────────────────────────────── */
function WeekDayChips({
  filterFrom,
  filterTo,
  setFilterFrom,
  setFilterTo,
}: {
  filterFrom: string;
  filterTo: string;
  setFilterFrom: (v: string) => void;
  setFilterTo: (v: string) => void;
}) {
  const days: Array<{ idx: number; label: string }> = [
    { idx: 1, label: '월' },
    { idx: 2, label: '화' },
    { idx: 3, label: '수' },
    { idx: 4, label: '목' },
    { idx: 5, label: '금' },
    { idx: 6, label: '토' },
    { idx: 0, label: '일' },
  ];

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekStart = (() => {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const m = new Date(now);
    m.setDate(now.getDate() - diff);
    return m;
  })();

  function dateForWeekday(targetIdx: number): string {
    // targetIdx: 0=일,1=월…6=토. 우리는 월요일=주 시작 기준
    const offsetFromMon = targetIdx === 0 ? 6 : targetIdx - 1;
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + offsetFromMon);
    return d.toISOString().slice(0, 10);
  }

  // 현재 선택된 단일 요일 (from === to 인 경우만 인식)
  const selectedDay = filterFrom && filterFrom === filterTo ? filterFrom : null;

  function pick(targetIdx: number) {
    const target = dateForWeekday(targetIdx);
    setFilterFrom(target);
    setFilterTo(target);
  }

  return (
    <div className="safety__week-chips">
      {days.map((d) => {
        const date = dateForWeekday(d.idx);
        const isFuture = date > todayStr;
        const isSelected = selectedDay === date;
        const isSun = d.idx === 0;
        const isSat = d.idx === 6;
        const cls =
          'safety__week-chip' +
          (isSelected ? ' is-active' : '') +
          (isFuture ? ' is-future' : '') +
          (isSun ? ' is-sun' : '') +
          (isSat ? ' is-sat' : '');
        return (
          <button
            key={d.idx}
            type="button"
            className={cls}
            disabled={isFuture}
            onClick={() => pick(d.idx)}
            title={`${date} (${d.label})`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
