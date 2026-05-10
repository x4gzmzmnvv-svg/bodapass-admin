/**
 * useInsuranceDeadlines — 4대보험 신고 마감일 일괄 조회 훅
 *
 *  · sites + members 를 자동으로 fetch 하고
 *  · localStorage 에 저장된 신고 완료 표시를 반영
 *  · 1분마다 자동 새로고침 (D-day 가 자정 지나면 -1 로 갱신)
 */

import { useEffect, useMemo, useState } from 'react';
import { siteApi } from '../api/site';
import { teamApi } from '../api/team';
import type { Site } from '../api/site.types';
import type { TeamMember } from '../api/team.types';
import {
  buildAllDeadlines,
  loadReportedDeadlines,
  summarizeDeadlines,
  type DeadlineItem,
  type DeadlineSummary,
} from '../utils/insuranceDeadlines';

interface UseDeadlinesResult {
  items: DeadlineItem[];
  summary: DeadlineSummary;
  loading: boolean;
  refresh: () => void;
}

export function useInsuranceDeadlines(): UseDeadlinesResult {
  const [sites, setSites] = useState<Site[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sitesRes, membersRes] = await Promise.all([
          siteApi.listSites(),
          teamApi.list().catch(() => ({ members: [] as TeamMember[] })),
        ]);
        if (cancelled) return;
        setSites(sitesRes.sites ?? []);
        setMembers(membersRes.members ?? []);
      } catch (e) {
        // 네트워크 오류 시 무시 (대시보드/사이드바에서 마감일 0건으로 표시)
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    // 1분마다 자동 새로고침 — D-day 자정 갱신 + 새 데이터 반영
    const t = window.setInterval(() => setReloadKey((k) => k + 1), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [reloadKey]);

  const items = useMemo(() => {
    if (loading) return [];
    const reported = loadReportedDeadlines();
    return buildAllDeadlines({ sites, members, reported });
  }, [sites, members, loading, reloadKey]);

  const summary = useMemo(() => summarizeDeadlines(items), [items]);

  return {
    items,
    summary,
    loading,
    refresh: () => setReloadKey((k) => k + 1),
  };
}
