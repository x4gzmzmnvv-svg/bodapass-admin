/**
 * 건설업 직종 데이터 (303개)
 * 출처: "직무범위.xlsx"
 *
 * 각 직종은 4대보험 분류표상 6개 카테고리 중 하나에 속합니다:
 *   - 건설채굴 단순 종사자 (116개)
 *   - 건설구조 기능원 (54개)
 *   - 건축마감 기능원 (44개)
 *   - 배관공 (30개)
 *   - 기타 건설 기능원 (33개)
 *   - 건설 채굴 기계 운전원 (26개)
 */

import jobsRaw from './jobs.json';

export interface JobDef {
  seq: number;
  name: string;
  description: string;
  employmentCode?: number | null;
  employmentName?: string;
  insuranceCode?: number | null;
  insuranceName?: string;
}

export const JOBS: JobDef[] = jobsRaw as JobDef[];

/** 4대보험 분류 카테고리 → 직종 목록 매핑 */
export const JOB_BY_CATEGORY: Record<string, JobDef[]> = JOBS.reduce(
  (acc, j) => {
    const cat = j.insuranceName || '기타';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(j);
    return acc;
  },
  {} as Record<string, JobDef[]>,
);

export const JOB_CATEGORIES: string[] = Object.keys(JOB_BY_CATEGORY).sort((a, b) => {
  // "기타"를 마지막으로
  if (a === '기타 건설 기능원') return 1;
  if (b === '기타 건설 기능원') return -1;
  return JOB_BY_CATEGORY[b].length - JOB_BY_CATEGORY[a].length;
});

/** 빠른 선택용 추천 직종 (출퇴근/노임비 화면에서 자주 쓰는 직종 우선) */
export const POPULAR_JOBS: string[] = [
  '철근공', '콘크리트공', '형틀목공', '건축목공', '용접공',
  '미장공', '도장공', '타일공', '도배공',
  '전공', '내선전공', '플랜트배관공', '배관공',
  '특별인부', '보통인부', '조력공', '작업반장',
];

/** 이름으로 직종 찾기 */
export function findJobByName(name: string): JobDef | undefined {
  return JOBS.find((j) => j.name === name);
}

/** 카테고리 표시색 (공수 그리드/임금 시트에서 색 구분) */
export function colorForCategory(cat: string): string {
  switch (cat) {
    case '건설구조 기능원':
      return '#15a09f';
    case '건축마감 기능원':
      return '#a855f7';
    case '배관공':
      return '#0ea5e9';
    case '건설 채굴 기계 운전원':
      return '#f59e0b';
    case '건설채굴 단순 종사자':
      return '#6b7280';
    default:
      return '#10b981';
  }
}
