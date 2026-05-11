/**
 * 관리자 웹 Mock Backend
 * 실서버 없이도 동작하도록 axios 어댑터로 응답을 만듭니다.
 *
 * ════════════════════════════════════════════════════════════════════
 *  데이터 일관성 정책 (Single Source of Truth)
 * ════════════════════════════════════════════════════════════════════
 *
 *  1) 인적 정보 (이름·일당·직종·은행·계좌·주민·반장 배정 등)
 *     → db.members        (TeamMember[])
 *     → 팀원 등록·수정 만 이 곳에 쓴다.
 *
 *  2) 일자별 출퇴근·공수
 *     → att:{siteId}:{yearMonth} 버킷 (AttendanceCacheBucket)
 *     → 얼굴 인식 / 수동 / 일괄 / 자동 18:00 — 모두 이 곳에 기록.
 *     → record.dailyWage 는 그날 단가 스냅샷(불변), record.payAmount = dailyWage × gongsu.
 *
 *  3) 노임비 (/wage/month)
 *     → "(2) attBucket 의 records" 를 그대로 합산해서 산출.
 *     → 새 데이터 없음. 출퇴근현황 페이지가 보는 그 데이터로 계산.
 *
 *  4) 퇴직금 (/severance/month)
 *     → "(2) att:{siteId}:* 모든 월 버킷" 누적. Math.random 금지.
 *
 *  5) 일/월 마감
 *     → bucket.dayCloses[date] / bucket.monthClose
 *     → 마감된 날짜는 isDateClosed 가 true → 423 Locked 반환.
 *
 *  ⚠ 절대 금지
 *   · 페이지 별로 임의 합계/추정/Math.random 사용
 *   · 같은 의미의 값을 여러 곳에 따로 저장 (member 의 dailyWage 는 한 곳만, 갱신은 한 트랜잭션으로)
 *   · 출퇴근·노임비·퇴직금이 다른 숫자를 보이면 즉시 버그로 간주
 * ════════════════════════════════════════════════════════════════════
 */

import type {
  AdminUser,
  CertificateUploadResponse,
  CheckLoginIdResponse,
  LoginRequest,
  LoginResponse,
  SignupStep3Request,
  SignupResponse,
} from './types';
import type {
  Company,
  CreateForemenRequest,
  CreateForemenResponse,
  CreateSiteRequest,
  DashboardSummary,
  Foreman,
  ForemanSite,
  ForemanMetrics,
  ForemanStatus,
  ListForemenResponse,
  ListForemanSitesResponse,
  ListSitesResponse,
  Site,
  SiteCompany,
  SiteCreateResponse,
} from './site.types';
import type {
  CreateOnlineInviteRequest,
  CreateOnlineInviteResponse,
  ListMembersResponse,
  RegisterMemberRequest,
  RegisterMemberResponse,
  TeamMember,
} from './team.types';
import type {
  PayoutDispatchResponse,
  SeveranceMonthSummary,
  SeveranceRow,
  WageMonthSummary,
  WageRow,
} from './wage.types';
import type {
  AttendanceMonth,
  AttCloseStage,
  AttendanceRecord,
  AuditLogEntry,
  BulkCheckOutRequest,
  BulkCheckOutResponse,
  CloseStage,
  CloseStatusResponse,
  DayClose,
  DayCloseRequest,
  ManualCheckRequest,
  ManualCheckResponse,
  MonthClose,
  MonthCloseRequest,
  TodayAttendance,
  WageCloseStage,
} from './attendance.types';
import { calcGongsu, isEarly, isLate } from '../utils/gongsu';
import { localYearMonth } from '../utils/dateLocal';
import { calcWageBreakdown } from '../utils/wageCalc';
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface MockReq { url: string; method: Method; data?: any; params?: any; }
interface MockResult { status: number; data?: any; }
type Handler = (req: MockReq) => MockResult | Promise<MockResult>;

const STORAGE_KEY = 'ilgampack_admin:mockdb';
const SEED_VERSION_KEY = 'ilgampack_admin:mockdb:version';
/** 시드를 변경할 때 이 버전을 올리면 사용자 브라우저의 캐시가 자동으로 갱신됩니다. */
const SEED_VERSION = '2026-05-12-v46-bugfix-utc-cap-cache';
const DELAY_MS = 300;
const wait = (ms = DELAY_MS) => new Promise((r) => setTimeout(r, ms));

function buildSeed() {
  // ─────── v40 테스트 클린 시드 ───────
  // · 회사 1개 (AKOMA), 현장 2개 (부산 IN_PROGRESS / 대전 COMPLETED), 반장 2명, 근로자 5명
  // · 출역 데이터: 2026-04 / 2026-05 만 (그 외 월은 빈 캘린더)
  // · 근로자 5명 중 3명 얼굴인식 (M-001~M-003), 2명 수동 입력 (M-004~M-005)

  // C-001 AKOMA건설 — 두 현장의 원도급
  const owner: AdminUser = {
    userId: 'A-001', loginId: 'akoma', name: '아코마',
    email: 'admin@akoma.co.kr', phoneNumber: '02-1234-5678',
    role: 'OWNER', companyId: 'C-001', companyName: '(주)AKOMA건설',
    lastLoginAt: new Date().toISOString(),
    assignedSiteId: 'ALL',
  };
  // 시연용 — kwlghd 부산 현장담당자
  const siteManager: AdminUser = {
    userId: 'A-002', loginId: 'kwlghd', name: '김지홍',
    email: 'kwlghd@gmail.com', phoneNumber: '010-9876-5432',
    role: 'MANAGER', companyId: 'C-001', companyName: '(주)AKOMA건설',
    lastLoginAt: new Date().toISOString(),
    assignedSiteId: 'S-2026-1043',
  };
  const credentials: Array<{ loginId: string; password: string; user: AdminUser }> = [
    { loginId: 'akoma',  password: 'akoma',  user: owner },
    { loginId: 'admin',  password: 'admin',  user: owner },
    { loginId: 'kwlghd', password: 'kwlghd', user: siteManager },
  ];

  // ───────── v40 테스트 클린 시드 정책 ─────────
  // · 회사 1개: AKOMA건설 (원도급)
  // · 현장 2개: 부산 마린시티 (IN_PROGRESS) + 대전 R&D 센터 (COMPLETED)
  // · 반장 2명: 모두 부산 현장 소속 (대전은 준공 → 추가 반장 없음)
  // · 근로자 5명: 모두 부산 현장. 3명(M-001~M-003) 얼굴인식, 2명(M-004~M-005) 수동입력
  // · 출역 데이터: 2026-04 / 2026-05 만 (seedAttendance 가드)

  const SITE_DEFS: Array<{ id: string; name: string; city: string; addr: string; client: string; clientType: string; mgr: string; mgrPhone: string; amount: number; start: string; end: string; progress: number; status?: 'IN_PROGRESS' | 'COMPLETED'; ownerCompanyId: string }> = [
    // ─── 부산 (시공중) — 5명 근로자가 일하는 곳 ───
    { id: 'S-2026-1043', name: '부산 해운대 마린시티 그랜드 오피스타워 복합 재개발 신축공사', city: '부산', addr: '부산 해운대구 우동 1408-1', client: '(주)마린시티개발', clientType: '민간', mgr: '김홍길', mgrPhone: '010-3676-9960', amount: 18_500_000_000, start: '2024-10-20', end: '2026-08-31', progress: 35, status: 'IN_PROGRESS', ownerCompanyId: 'C-001' },
    // ─── 대전 (준공) ───
    { id: 'S-2026-1057', name: '대전 유성구 R&D 센터 신축', city: '대전', addr: '대전 유성구 용산동 524', client: '대전테크노파크', clientType: '공공', mgr: '이재훈', mgrPhone: '010-4421-9830', amount: 9_800_000_000, start: '2025-06-15', end: '2027-06-30', progress: 55, status: 'IN_PROGRESS', ownerCompanyId: 'C-001' },
  ];

  const sites: Site[] = SITE_DEFS.map((d) => ({
    id: d.id, name: d.name,
    contractKind: '원도급',
    contractDescription: '신축공사',
    contractAmount: d.amount,
    contractDate: d.start, startDate: d.start, endDate: d.end,
    bidNoticeDate: d.start, insuranceBaseDate: d.start,
    client: d.client, clientType: d.clientType,
    zipCode: '00000', address: d.addr, addressDetail: '',
    manager: d.mgr, managerPhone: d.mgrPhone, managerFax: '',
    siteAgent: { name: d.mgr, phone: d.mgrPhone },
    safetyOfficer: { name: '안전팀', phone: '010-0000-0000' },
    qualityInspector: { name: '품질팀', phone: '010-0000-0000' },
    progressPercent: d.progress,
    workerCount: { formwork: 0, masonry: 0, facility: 0, electric: 0 },
    workDescription: '', status: d.status ?? 'IN_PROGRESS',
    createdAt: new Date(d.start).toISOString(),
    scale: d.amount < 500_000_000 ? 'SMALL' : 'NORMAL',
    ownerCompanyId: d.ownerCompanyId,
    inviteCode: ('GANG' + d.id.slice(-4)).toUpperCase(),
    geofence: defaultGeofenceForCity(d.city),
    // 시연 — 대전 R&D 센터 / 세종 행정타운은 「본사 직접 처리」 모드, 그 외엔 「현장 사무실 처리」
    attendanceConfirmMode:
      d.id === 'S-2026-1057' || d.id === 'S-2025-1011' ? 'HQ_DIRECT' : 'SITE_OFFICE',
  }));

  // ─── 회사 시드 (1개) — AKOMA건설만 ───
  const companies: Company[] = [
    { id: 'C-001', name: '(주)AKOMA건설', bizNo: '123-45-67890', companyCode: 'C-26-000001', representative: '아코마', ownerUserId: 'A-001', createdAt: new Date('2024-01-01').toISOString() },
  ];

  // ─── SiteCompany 시드 — 각 현장의 원도급(AKOMA) 만 ───
  const siteCompanies: SiteCompany[] = sites.map((s, i) => ({
    id: 'SC-' + String(i + 1).padStart(3, '0'),
    siteId: s.id, companyId: 'C-001', role: '원도급',
    joinedAt: s.startDate, status: 'ACTIVE',
    contractAmount: s.contractAmount,
    startDate: s.startDate, endDate: s.endDate,
    progressPercent: s.progressPercent,
  }));

  // ───────── 한국 이름 풀 ─────────
  const SURNAMES = ['김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권','황','안','송','류','전','홍','고','문','양','손','배','백','허','유','남'];
  const GIVEN_NAMES_M = ['민수','진우','성호','동현','재훈','현우','준영','병철','상민','주현','기태','영호','태현','정호','승완','현진','동민','성준','도현','민호','태우','경수','봉식','영길','종우','학수','만호','종민','길동','태호','길수','인범','명수','승재','지훈','현태','상호','우진','범수','정훈'];
  const FOREIGN = ['Hong Tien','Le Van Minh','Tran Quoc Anh','Nguyen Van Phu','Pham Quang Hai','Bui Duc Manh','Kuldeep Singh','Rajesh Kumar','Mahesh Patel'];

  function nameOf(idx: number, foreign = false): string {
    if (foreign && idx % 11 === 7) return FOREIGN[idx % FOREIGN.length];
    const s = SURNAMES[idx % SURNAMES.length];
    const g = GIVEN_NAMES_M[Math.floor(idx / SURNAMES.length) % GIVEN_NAMES_M.length];
    const g2 = GIVEN_NAMES_M[(Math.floor(idx / SURNAMES.length) + Math.floor(idx / 7)) % GIVEN_NAMES_M.length];
    return s + (idx % 2 === 0 ? g : g2);
  }
  function phoneOf(idx: number): string {
    const a = String(1000 + ((idx * 137) % 9000)).padStart(4, '0');
    const b = String(1000 + ((idx * 421 + 7) % 9000)).padStart(4, '0');
    return `010-${a}-${b}`;
  }
  function idOf(idx: number, foreign = false): { raw: string; mask: string } {
    const yy = String(60 + (idx % 38)).padStart(2, '0');
    const mm = String(1 + (idx % 12)).padStart(2, '0');
    const dd = String(1 + (idx % 28)).padStart(2, '0');
    const sex = foreign ? (idx % 2 === 0 ? '5' : '6') : (idx % 2 === 0 ? '1' : '2');
    const tail = String(100000 + ((idx * 70709) % 900000)).slice(0, 6);
    return {
      raw: `${yy}${mm}${dd}-${sex}${tail}`,
      mask: `${yy}${mm}${dd}-${sex}******`,
    };
  }
  const BANKS = ['국민','신한','농협','하나','우리','IBK기업','카카오뱅크','토스뱅크'];
  function accountOf(idx: number): { bank: string; raw: string; mask: string } {
    const bank = BANKS[idx % BANKS.length];
    const a = String(100 + (idx * 13) % 900).padStart(3, '0');
    const mid = String(100000 + (idx * 137) % 900000).padStart(6, '0');
    const c = String(1000 + (idx * 71) % 9000).padStart(4, '0');
    return { bank, raw: `${a}-${mid}-${c}`, mask: `${a}-***-${c}` };
  }
  /** 워커 코드 — W-26-NNNNNN, member.id 해시 기반 결정적 */
  function workerCodeOf(memberId: string): string {
    let h = 0;
    for (const c of memberId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    return 'W-26-' + String(h % 1_000_000).padStart(6, '0');
  }

  const FOREMAN_ROLES = ['형틀','철근','콘크리트','미장','전기','설비','용접','방수'];
  const MEMBER_ROLES = ['형틀공','철근공','콘크리트공','미장공','도장공','방수공','타일공','전기공','설비공','용접공','도배공','보조'];

  // ───────── 2명 반장 (v40: 모두 부산 현장 — siteIdx 0) ─────────
  const FOREMAN_PLAN: Array<{ siteIdx: number; registered: boolean; companyId: string }> = [
    { siteIdx: 0, registered: true, companyId: 'C-001' },  // F-001
    { siteIdx: 0, registered: true, companyId: 'C-001' },  // F-002
  ];
  const findSc = (siteId: string, companyId: string) =>
    siteCompanies.find((sc) => sc.siteId === siteId && sc.companyId === companyId);
  const foremen: Foreman[] = FOREMAN_PLAN.map((p, i) => {
    const id = 'F-' + String(i + 1).padStart(3, '0');
    const siteId = sites[p.siteIdx].id;
    const sc = findSc(siteId, p.companyId);
    const invitedDaysAgo = (i % 7) + 1;
    const registered = p.registered;
    // status — 가입 완료 + 현장 배정 + 최근 활동 → ACTIVE
    //          가입 완료 + 현장 배정 만 → ASSIGNED
    //          미가입 → INVITED
    //          (시연용) 마지막 1명은 SUSPENDED 로 두어 상태 다양성 노출
    let status: ForemanStatus;
    if (!registered) {
      status = invitedDaysAgo > 5 ? 'PENDING_REGISTRATION' : 'INVITED';
    } else {
      status = 'ACTIVE';
    }
    const registeredAt = registered
      ? new Date(Date.now() - 86_400_000 * (invitedDaysAgo - 1)).toISOString()
      : undefined;
    const lastActiveAt =
      status === 'ACTIVE'
        ? new Date(Date.now() - 86_400_000 * (i % 3)).toISOString()
        : undefined;
    return {
      id,
      name: nameOf(i),
      phone: phoneOf(i),
      siteId, siteCompanyId: sc?.id,
      role: FOREMAN_ROLES[i % FOREMAN_ROLES.length],
      notifyChannel: i % 2 === 0 ? 'KAKAO' : 'SMS',
      invitedAt: new Date(Date.now() - 86_400_000 * invitedDaysAgo).toISOString(),
      registered,
      status,
      registeredAt,
      lastActiveAt,
      defaultCompanyId: p.companyId,
    };
  });

  // ───────── ForemanSite — 반장 × 현장 배정 (다대다) ─────────
  // 시드 단계에선 등록완료 반장(F-001~F-004) 각자에게 1건씩의 「주반장」 배정.
  // F-005 는 미가입 상태라 ForemanSite 없음.
  // F-001 은 부산 현장에도 「임시반장」으로 1건 추가하여 다대다 관계 시연.
  const foremanSites: ForemanSite[] = [];
  const TODAY = new Date();
  const isoDate = (d: Date) => localDateStr(d);
  const addDays = (d: Date, days: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  };
  for (const f of foremen) {
    if (!f.registered) continue;
    const sc = findSc(f.siteId, f.defaultCompanyId ?? '');
    foremanSites.push({
      id: 'FS-' + f.id + '-1',
      foremanId: f.id,
      siteId: f.siteId,
      companyId: f.defaultCompanyId ?? '',
      siteCompanyId: sc?.id,
      trade: f.role ?? '기타',
      role: '주반장',
      permissionPreset: 'STANDARD',
      startDate: isoDate(addDays(TODAY, -30)),
      endDate: isoDate(addDays(TODAY, 60)),
      dailyWage: 280_000,
      headcount: 7,
      isPrimary: true,
      assignedAt: new Date(Date.now() - 86_400_000 * 30).toISOString(),
      status: 'ACTIVE',
      approvedAt: new Date(Date.now() - 86_400_000 * 28).toISOString(),
    });
  }
  // (v40 — 부산 현장 외에 다른 현장 없음. 임시반장 시드 제거)

  // ───────── 10명 근로자 (v45: 부산 5명 + 대전 5명) ─────────
  // joinedAt 분포:
  //  · 8명: 2026-04-01 (1년 미만 — 공제회 부금 대상)
  //  · 1명: 2025-06-15 (1년 임박 — D-30 이내 경고)
  //  · 1명: 2025-04-01 (1년 이상 — 법정퇴직금 대상)
  // 한 명은 외국인(idType=2) 으로 다양성 확보.
  // 사이트 분배: 부산(siteIdx=0) 5명, 대전(siteIdx=1) 5명.
  const busanSite = sites[0];   // S-2026-1043 부산
  const daejeonSite = sites[1]; // S-2026-1057 대전
  // FACE/MANUAL 분류는 seedAttendance 의 멤버 번호 규칙으로 처리됨
  // v45 — 7명 FACE / 3명 MANUAL = 70/30%
  const MEMBER_DEFS: Array<{
    id: string; name: string; role: string; dailyWage: number; foremanIdx: number;
    joinedAt: string; siteIdx: 0 | 1; isForeign?: boolean;
  }> = [
    // 부산 현장 (5명)
    { id: 'M-001', name: '한동현',       role: '형틀공',     dailyWage: 200_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 0 },
    { id: 'M-002', name: '오성준',       role: '철근공',     dailyWage: 220_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 0 },
    { id: 'M-003', name: '서동현',       role: '콘크리트공', dailyWage: 240_000, foremanIdx: 1, joinedAt: '2026-04-01', siteIdx: 0 },
    { id: 'M-004', name: '신성준',       role: '미장공',     dailyWage: 260_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 0 },
    { id: 'M-005', name: '권동현',       role: '도장공',     dailyWage: 280_000, foremanIdx: 1, joinedAt: '2025-04-01', siteIdx: 0 }, // 1년 이상
    // 대전 현장 (5명)
    { id: 'M-006', name: 'Rajesh Kumar', role: '타일공',     dailyWage: 230_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 1, isForeign: true },
    { id: 'M-007', name: '전도현',       role: '용접공',     dailyWage: 270_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 1 },
    { id: 'M-008', name: '문동현',       role: '형틀공',     dailyWage: 200_000, foremanIdx: 0, joinedAt: '2025-06-15', siteIdx: 1 }, // 1년 임박
    { id: 'M-009', name: '배민호',       role: '미장공',     dailyWage: 250_000, foremanIdx: 1, joinedAt: '2026-04-01', siteIdx: 1 },
    { id: 'M-010', name: '송도현',       role: '전기공',     dailyWage: 260_000, foremanIdx: 0, joinedAt: '2026-04-01', siteIdx: 1 },
  ];
  const members: TeamMember[] = MEMBER_DEFS.map((m, idx) => {
    const acct = accountOf(idx);
    const idPair = idOf(idx, m.isForeign);
    const assignedForeman = foremen[m.foremanIdx];
    const targetSite = m.siteIdx === 1 ? daejeonSite : busanSite;
    return {
      id: m.id,
      name: m.name,
      phone: phoneOf(100 + idx),
      role: m.role,
      siteId: targetSite.id,
      siteCompanyId: assignedForeman?.siteCompanyId,
      foremanId: assignedForeman?.id,
      assignedToSiteManager: false,
      dailyWage: m.dailyWage,
      idType: m.isForeign ? 2 : 1,
      idNumberMasked: idPair.mask,
      idNumberRaw: idPair.raw,
      bankName: acct.bank,
      accountMasked: acct.mask,
      accountNumberRaw: acct.raw,
      registrationMode: 'IN_PERSON' as any,
      status: 'ACTIVE',
      joinedAt: m.joinedAt,
      insurance: { pension: true, health: true, employment: true, accident: true },
      safetyEduCompleted: true,
      contractSigned: true,
      contractSignedAt: m.joinedAt,
      faceVerified: true,
      workerCode: workerCodeOf(m.id),
      trustTier: 1,
    };
  });

  const invites: Array<{
    inviteId: string; inviteToken: string; name: string; phone: string; siteId: string; smsSentAt: string;
  }> = [];

  // ───────── 안전관리 시드 ─────────
  // 12종 표준 카테고리 (고용노동부·KOSHA 가이드 기반)
  const safetyCategories = [
    { icon: '🌅', title: 'TBM · 출근 전 안전공지', severity: 'NORMAL',   appliedRoles: [],
      defaultMsg: '[금일 안전공지] 작업 전 TBM 참석 필수입니다. 안전모·안전화·안전대 착용 확인 후 작업 시작 바랍니다.' },
    { icon: '🪜', title: '추락 위험 작업',          severity: 'CRITICAL', appliedRoles: ['형틀','철근','비계','지붕','외장','조적','콘크리트'],
      defaultMsg: '[추락주의] 금일 고소작업 예정입니다. 안전대 고리 체결, 개구부 덮개 고정, 안전난간 확인 후 작업 바랍니다.' },
    { icon: '🚜', title: '장비 · 차량 작업',        severity: 'CAUTION',  appliedRoles: ['굴착','중장비','크레인','지게차','덤프','레미콘'],
      defaultMsg: '[장비작업 주의] 장비 작업반경 내 접근 금지입니다. 유도자 신호 없이 장비 이동 금지.' },
    { icon: '🏗', title: '양중 · 인양 작업',         severity: 'CAUTION',  appliedRoles: ['철골','크레인','신호수','철근','거푸집','PC'],
      defaultMsg: '[양중작업 알림] 인양물 하부 출입을 금지합니다. 줄걸이 상태, 샤클·슬링 손상 여부 확인 후 작업 바랍니다.' },
    { icon: '⛏', title: '굴착 · 흙막이 · 터파기',    severity: 'CAUTION',  appliedRoles: ['굴착','토공','흙막이','관로','맨홀'],
      defaultMsg: '[굴착작업 주의] 굴착면 주변 접근을 제한합니다. 토사 붕괴 위험이 있으니 정해진 통로로 이동.' },
    { icon: '🔥', title: '화기 · 용접 · 절단',       severity: 'CRITICAL', appliedRoles: ['용접','철골','금속','방수','우레탄'],
      defaultMsg: '[화기작업 주의] 용접·절단 작업 전 주변 가연물 제거, 소화기 비치, 불티 비산방지포 설치 바랍니다.' },
    { icon: '🫧', title: '밀폐공간 · 질식 위험',     severity: 'CRITICAL', appliedRoles: ['배관','설비','지하','맨홀','저수조'],
      defaultMsg: '[밀폐공간 작업] 작업 전 산소·유해가스 농도 측정, 환기, 감시인 배치 후 출입하세요.' },
    { icon: '⚡', title: '감전 · 전기 작업',         severity: 'CAUTION',  appliedRoles: ['전기','정보통신','소방','설비'],
      defaultMsg: '[감전주의] 우천 후 전동공구 사용 전 누전차단기와 케이블 손상 여부를 확인하세요.' },
    { icon: '☀',  title: '폭염·한파·우천·강풍',     severity: 'CAUTION',  appliedRoles: [],
      defaultMsg: '[폭염주의] 물·그늘·휴식 준수 바랍니다. 어지러움, 두통, 구토 증상 발생 시 즉시 작업을 중지하고 관리자에게 보고하세요.' },
    { icon: '🚧', title: '낙하물 · 자재 정리',       severity: 'NORMAL',   appliedRoles: ['외장','비계','형틀','철근','조적'],
      defaultMsg: '[낙하물 주의] 상부 작업구간 하부 출입을 금지합니다. 자재 적치 상태를 확인하고, 공구·자재는 낙하방지 조치 후 사용하세요.' },
    { icon: '👷', title: '신규 · 외국인 근로자 투입', severity: 'NORMAL',   appliedRoles: [],
      defaultMsg: '[신규자 안전안내] 현장 출입 전 안전교육 이수 후 작업 가능합니다. 지정 통로 이용, 보호구 착용, 위험구역 임의 출입 금지 바랍니다.' },
    { icon: '🚨', title: '사고 · 아차사고 재발방지', severity: 'CRITICAL', appliedRoles: [],
      defaultMsg: '[사고사례 전파] 타 현장에서 개구부 추락사고가 발생했습니다. 금일 전 구역 개구부 덮개 고정, 안전난간, 안전대 체결 상태를 재점검 바랍니다.' },
  ].map((c, i) => ({
    id: 'SCAT-' + String(i + 1).padStart(2, '0'),
    icon: c.icon,
    title: c.title,
    defaultMsg: c.defaultMsg,
    severity: c.severity as 'NORMAL' | 'CAUTION' | 'CRITICAL',
    isStandard: true,
    sortOrder: i,
    createdAt: '2026-04-01T09:00:00.000Z',
    appliedRoles: c.appliedRoles,
  }));

  // 더미 발송 이력 — 최근 30일에 무작위 분포 (시연용)
  const owner0 = owner;
  const safetyMessages: Array<{
    id: string; categoryId: string | null; categoryTitle: string; message: string;
    severity: 'NORMAL' | 'CAUTION' | 'CRITICAL';
    recipients: Array<{ kind: string; id: string; name: string; phone?: string; siteId?: string; siteName?: string }>;
    channels: Array<'SMS' | 'APP'>;
    audienceFilter: 'ALL_REGISTERED' | 'WORKING_TODAY' | 'BY_FOREMAN' | 'BY_ROLE' | 'CUSTOM';
    sentBy: { userId: string; name: string };
    sentAt: string;
    status: 'SENT' | 'PARTIAL' | 'FAILED';
    failures?: Array<{ recipientId: string; recipientName: string; reason: string }>;
    readReceipts: Array<{ recipientId: string; recipientName: string; readAt?: string; via?: 'APP' | 'REPLY' | 'FOREMAN' }>;
    deliveryAttempts: Array<{ attempt: number; at: string; unreadCount: number; targetCount: number; triggeredBy: { userId: string; name: string } | 'system' }>;
  }> = [];
  const safetyAudit: Array<{
    id: string; type: string; performedBy: { userId: string; name: string };
    performedAt: string; targetId: string; summary: string; payload?: Record<string, unknown>;
  }> = [];

  // 시연용 — 12개 카테고리 각각 1~3건씩 발송 이력 생성 (총 ~24건)
  let msgIdx = 0;
  let auditIdx = 0;
  const todayMs = Date.now();
  for (let ci = 0; ci < safetyCategories.length; ci++) {
    const cat = safetyCategories[ci];
    const count = (ci % 3) + 1;
    for (let k = 0; k < count; k++) {
      const daysAgo = (ci * 2 + k * 5) % 28;
      const sentAt = new Date(todayMs - daysAgo * 24 * 3600 * 1000 - (k + 1) * 3 * 3600 * 1000).toISOString();
      const targetSite = sites[ci % sites.length];
      const siteForemen = foremen.filter((f) => f.siteId === targetSite.id).slice(0, 3);
      const recipients = siteForemen.map((f) => ({
        kind: 'FOREMAN', id: f.id, name: f.name, phone: f.phone,
        siteId: targetSite.id, siteName: targetSite.name,
      }));
      const channels: Array<'SMS' | 'APP'> = k % 3 === 0 ? ['SMS'] : k % 3 === 1 ? ['APP'] : ['SMS', 'APP'];
      const audienceFilter: 'ALL_REGISTERED' | 'WORKING_TODAY' | 'BY_FOREMAN' = (k % 2 === 0 ? 'WORKING_TODAY' : 'ALL_REGISTERED');
      // 더미 read-receipt — 시간이 오래 지난 건 대부분 read, 최근 건 일부만 read
      const readRatio = Math.min(1, 0.4 + daysAgo / 30);
      const readReceipts = recipients.map((r, ri) => {
        const isRead = ri / Math.max(1, recipients.length) < readRatio;
        return {
          recipientId: r.id,
          recipientName: r.name,
          readAt: isRead ? new Date(new Date(sentAt).getTime() + (10 + ri * 7) * 60 * 1000).toISOString() : undefined,
          via: isRead ? (ri % 3 === 0 ? 'FOREMAN' as const : ri % 3 === 1 ? 'REPLY' as const : 'APP' as const) : undefined,
        };
      });
      const unreadCount = readReceipts.filter((r) => !r.readAt).length;
      const status = recipients.length === 0 ? 'FAILED' : (unreadCount > 0 ? 'PARTIAL' : 'SENT');
      const id = 'SMSG-' + String(++msgIdx).padStart(4, '0');
      safetyMessages.push({
        id,
        categoryId: cat.id,
        categoryTitle: cat.title,
        message: cat.defaultMsg,
        severity: cat.severity,
        recipients,
        channels,
        audienceFilter,
        sentBy: { userId: owner0.userId, name: owner0.name },
        sentAt,
        status,
        readReceipts,
        deliveryAttempts: [{
          attempt: 1,
          at: sentAt,
          unreadCount: recipients.length,
          targetCount: recipients.length,
          triggeredBy: { userId: owner0.userId, name: owner0.name },
        }],
      });
      safetyAudit.push({
        id: 'SADT-' + String(++auditIdx).padStart(4, '0'),
        type: 'SEND_MESSAGE',
        performedBy: { userId: owner0.userId, name: owner0.name },
        performedAt: sentAt,
        targetId: id,
        summary: `${cat.title} 발송 — ${recipients.length}명 (${channels.join(', ')})`,
        payload: { siteId: targetSite.id, siteName: targetSite.name, recipientCount: recipients.length },
      });
    }
  }
  // 정렬 — 최신이 먼저
  safetyMessages.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
  safetyAudit.sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1));

  return {
    auth: { accessToken: 'mock-admin-access-token', refreshToken: 'mock-admin-refresh-token' },
    credentials, sites, foremen, foremanSites, members, invites,
    companies, siteCompanies,
    safetyCategories, safetyMessages, safetyAudit,
  };
}

type DB = ReturnType<typeof buildSeed>;

function loadDb(): DB {
  try {
    // 시드 버전이 다르면 옛 캐시를 버리고 새 시드를 다시 만든다.
    const cachedVersion = localStorage.getItem(SEED_VERSION_KEY);
    if (cachedVersion === SEED_VERSION) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DB;
        // 방어적 backfill — 옛 멤버에 idNumberRaw / accountNumberRaw 가 없으면
        // 마스킹의 별표 자리를 ?로만 바꿔 raw 자리표시로 둔다 (앞부분은 절대 바꾸지 않음)
        let dirty = false;
        (parsed.members ?? []).forEach((m: any) => {
          if (!m.idNumberRaw && m.idNumberMasked) {
            m.idNumberRaw = (m.idNumberMasked as string).replace(/\*+/g, (s) => '?'.repeat(s.length));
            dirty = true;
          }
          if (!m.accountNumberRaw && m.accountMasked) {
            m.accountNumberRaw = (m.accountMasked as string).replace(/\*+/g, (s) => '?'.repeat(s.length));
            dirty = true;
          }
        });
        if (dirty) localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        return parsed;
      }
    } else {
      localStorage.removeItem(STORAGE_KEY);
      // 시드 버전이 바뀌었을 때 — 출퇴근 버킷, 토큰, 새 prefix 의 영속 데이터 모두 정리.
      // 옛 user 캐시에는 assignedSiteId 가 없어서 viewMode 가 항상 HQ 로 계산되는 문제 방지.
      // bodapass_admin:* — severance_fund_daily / wage_ledger_archive / contract_company 등
      //   옛 시드의 site/member id 를 참조하는 데이터가 살아남으면 stale 위험.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('att:') || k.startsWith('bodapass_admin:')) {
          localStorage.removeItem(k);
        }
      }
      localStorage.removeItem('ilgampack_admin:user');
      localStorage.removeItem('ilgampack_admin:accessToken');
      localStorage.removeItem('ilgampack_admin:refreshToken');
    }
  } catch { /* ignore */ }
  const seed = buildSeed();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  localStorage.setItem(SEED_VERSION_KEY, SEED_VERSION);
  return seed;
}
function saveDb(db: DB) { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }

/** 현재 로그인된 사용자 — DB.currentLoginId 로 식별 */
function currentUserOf(db: DB): AdminUser | null {
  const loginId = (db as any).currentLoginId as string | undefined;
  if (!loginId) return null;
  const cred = db.credentials.find((c) => c.loginId === loginId);
  return cred?.user ?? null;
}

export function resetMockDb() {
  // mockdb·버전·토큰·출퇴근 버킷·신 prefix 영속 데이터 모두 정리
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k.startsWith('ilgampack_admin:') ||
      k.startsWith('att:') ||
      k.startsWith('bodapass_admin:')
    ) {
      localStorage.removeItem(k);
    }
  }
  if (typeof window !== 'undefined') window.location.reload();
}

const handlers: Array<{ pattern: RegExp; method: Method; fn: Handler }> = [];
const route = (method: Method, pattern: RegExp, fn: Handler) =>
  handlers.push({ method, pattern, fn });

route('post', /^\/auth\/login$/, async (req) => {
  const db = loadDb();
  const body = req.data as LoginRequest;
  const found = db.credentials.find((c) => c.loginId === body.loginId && c.password === body.password);
  if (!found) return { status: 401, data: { message: '아이디 또는 비밀번호가 올바르지 않습니다.' } };
  const updated: AdminUser = { ...found.user, lastLoginAt: new Date().toISOString() };
  found.user = updated;
  // 현재 로그인된 loginId 를 db 에 기록 — /auth/me 가 이걸로 사용자 식별
  (db as any).currentLoginId = found.loginId;
  saveDb(db);
  const res: LoginResponse = {
    accessToken: db.auth.accessToken, refreshToken: db.auth.refreshToken, user: updated,
  };
  return { status: 200, data: res };
});
route('post', /^\/auth\/logout$/, async () => {
  const db = loadDb();
  (db as any).currentLoginId = undefined;
  saveDb(db);
  return { status: 200, data: { ok: true } };
});
route('get', /^\/auth\/me$/, async () => {
  const db = loadDb();
  const currentLoginId = (db as any).currentLoginId;
  // 현재 로그인된 사용자가 있으면 그 사용자 반환, 없으면 401
  const cred = currentLoginId
    ? db.credentials.find((c) => c.loginId === currentLoginId)
    : null;
  if (!cred) return { status: 401, data: { message: '인증이 필요합니다.' } };
  return { status: 200, data: cred.user };
});
route('post', /^\/auth\/refresh$/, async () => {
  const db = loadDb();
  return { status: 200, data: db.auth };
});

const RESERVED_LOGIN_IDS = ['admin', 'root', 'system', 'ilgampack', 'akoma'];

route('get', /^\/auth\/signup\/check-id$/, async (req) => {
  const loginId = String(req.params?.loginId ?? '').trim().toLowerCase();
  if (!loginId) return { status: 400, data: { message: 'loginId는 필수입니다.' } };
  if (!/^[a-z0-9]{4,20}$/.test(loginId)) {
    const res: CheckLoginIdResponse = { loginId, available: false, reason: '아이디 형식이 올바르지 않습니다.' };
    return { status: 200, data: res };
  }
  if (RESERVED_LOGIN_IDS.includes(loginId)) {
    const res: CheckLoginIdResponse = { loginId, available: false, reason: '시스템 예약어입니다. 다른 아이디를 입력해주세요.' };
    return { status: 200, data: res };
  }
  const db = loadDb();
  const taken = db.credentials.some((c) => c.loginId === loginId);
  const res: CheckLoginIdResponse = { loginId, available: !taken, reason: taken ? '이미 사용 중인 아이디입니다.' : undefined };
  return { status: 200, data: res };
});
route('post', /^\/auth\/signup\/upload-certificate$/, async () => {
  const id = 'CERT-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const res: CertificateUploadResponse = { certificatePath: '/mock/certs/' + id + '.pfx', certificateId: id, cn: 'Sample Certificate' };
  return { status: 200, data: res };
});
route('post', /^\/auth\/signup\/submit$/, async (req) => {
  const body = req.data as SignupStep3Request;
  if (!body?.user?.loginId || !body?.company?.companyName) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  }
  const db = loadDb();
  const userId = 'A-' + Date.now().toString().slice(-6);
  const companyId = 'C-' + Date.now().toString().slice(-6);
  const newUser: AdminUser = {
    userId, loginId: body.user.loginId, name: body.user.name,
    phoneNumber: body.user.phoneNumber, role: 'OWNER',
    companyId, companyName: body.company.companyName,
  };
  db.credentials.push({ loginId: body.user.loginId, password: body.user.password, user: newUser });
  saveDb(db);
  const res: SignupResponse = {
    userId, companyId, loginId: newUser.loginId,
    createdAt: new Date().toISOString(),
    accessToken: db.auth.accessToken, refreshToken: db.auth.refreshToken,
  };
  return { status: 200, data: res };
});

route('get', /^\/sites$/, async () => {
  const db = loadDb();
  const me = currentUserOf(db);
  const all = db.sites ?? [];
  let visible = all;
  if (me) {
    if (me.assignedSiteId && me.assignedSiteId !== 'ALL') {
      // 현장담당자 — 자기 site 1건
      visible = all.filter((s) => s.id === me.assignedSiteId);
    } else {
      // 본사 — 자기 회사가 SiteCompany 로 참여한 site 만
      const mySiteIds = new Set(
        (db.siteCompanies ?? [])
          .filter((sc) => sc.companyId === me.companyId && sc.status === 'ACTIVE')
          .map((sc) => sc.siteId),
      );
      visible = all.filter((s) => mySiteIds.has(s.id));
    }
  }
  const res: ListSitesResponse = { sites: visible, total: visible.length };
  return { status: 200, data: res };
});

// ─── 회사 목록 ───
route('get', /^\/companies$/, async () => {
  const db = loadDb();
  return { status: 200, data: { companies: db.companies ?? [] } };
});

// ─── SiteCompany (현장-회사 참여 관계) 목록 ───
//   ?siteId, ?companyId 로 필터
//
// 가시성 정책:
//  - 사용자 회사가 해당 site 의 owner(원도급사) → 그 site 의 모든 SiteCompany 가시
//  - 그 외 (하도급으로 참여 중) → owner 의 SiteCompany + 자기 회사 SiteCompany 만 가시
//                                  (다른 협력업체는 숨김)
//  - 사용자 회사가 그 site 에 아예 없으면 → 그 site 의 SiteCompany 모두 숨김
route('get', /^\/site-companies$/, async (req) => {
  const db = loadDb();
  const params = req.params ?? {};
  const me = currentUserOf(db);
  const sitesById = new Map((db.sites ?? []).map((s) => [s.id, s] as const));
  let list = db.siteCompanies ?? [];
  if (params.siteId) list = list.filter((sc) => sc.siteId === params.siteId);
  if (params.companyId) list = list.filter((sc) => sc.companyId === params.companyId);

  if (me) {
    list = list.filter((sc) => {
      const site = sitesById.get(sc.siteId);
      if (!site) return false;
      const iAmOwner = site.ownerCompanyId === me.companyId;
      const ownerSc = (db.siteCompanies ?? []).find(
        (x) => x.siteId === sc.siteId && x.companyId === site.ownerCompanyId,
      );
      const myScInThisSite = (db.siteCompanies ?? []).find(
        (x) => x.siteId === sc.siteId && x.companyId === me.companyId,
      );
      // 우리 회사가 그 site 에 아예 안 들어가 있으면 그 site 의 모든 SC 숨김
      if (!myScInThisSite) return false;
      // 내가 owner: 모두 보임
      if (iAmOwner) return true;
      // 하도급 입장: owner SC + 내 SC 만
      return sc.id === ownerSc?.id || sc.companyId === me.companyId;
    });
  }
  return { status: 200, data: { siteCompanies: list } };
});

// ─── 초대 코드로 합류 ───
//  body: { inviteCode, companyId, specialty? }
//  → 해당 코드의 site 찾고, companyId 가 이미 SiteCompany 에 있으면 거절,
//     없으면 새 SiteCompany 행 (role='하도급', status='ACTIVE') 생성
route('post', /^\/site-companies\/join$/, async (req) => {
  const db = loadDb();
  const body = req.data as {
    inviteCode?: string;
    companyId?: string;
    specialty?: string;
  };
  const code = (body.inviteCode || '').trim().toUpperCase();
  if (!code) return { status: 400, data: { message: '초대 코드를 입력해주세요.' } };
  if (!body.companyId) return { status: 400, data: { message: '회사 정보가 없습니다.' } };

  const target = (db.sites ?? []).find(
    (s) => (s.inviteCode || '').toUpperCase() === code,
  );
  if (!target) {
    return {
      status: 404,
      data: { message: '유효하지 않은 초대 코드입니다. 코드를 다시 확인해주세요.' },
    };
  }

  const exists = (db.siteCompanies ?? []).find(
    (sc) => sc.siteId === target.id && sc.companyId === body.companyId,
  );
  if (exists) {
    return {
      status: 409,
      data: {
        message: '이미 합류된 현장입니다.',
        siteCompany: exists,
        site: target,
      },
    };
  }

  const newSc: SiteCompany = {
    id: 'SC-' + Date.now().toString(36).toUpperCase(),
    siteId: target.id,
    companyId: body.companyId,
    role: '하도급',
    specialty: body.specialty?.trim() || undefined,
    joinedAt: new Date().toISOString(),
    status: 'ACTIVE',
  };
  db.siteCompanies = [...(db.siteCompanies ?? []), newSc];
  saveDb(db);
  return {
    status: 201,
    data: {
      siteCompany: newSc,
      site: target,
      message: `${target.name} 에 하도급으로 합류되었습니다.`,
    },
  };
});
route('get', /^\/sites\/[^/]+$/, async (req) => {
  const db = loadDb();
  const id = req.url.split('/').pop()!;
  const site = (db.sites ?? []).find((s) => s.id === id);
  if (!site) return { status: 404, data: { message: '현장을 찾을 수 없습니다.' } };
  return { status: 200, data: site };
});
route('patch', /^\/sites\/[^/]+$/, async (req) => {
  const id = req.url.split('/').pop()!;
  const body = (req.data || {}) as Partial<Site>;
  const db = loadDb();
  const idx = (db.sites ?? []).findIndex((s) => s.id === id);
  if (idx < 0) return { status: 404, data: { message: '현장을 찾을 수 없습니다.' } };
  // 수정 허용 필드 (시연용 — 운영에서는 스키마 기반 검증)
  const allowed: (keyof Site)[] = [
    'name', 'contractKind', 'contractAmount', 'contractDate', 'startDate', 'endDate',
    'client', 'address', 'addressDetail', 'manager', 'managerPhone', 'managerFax',
    'progressPercent', 'status',
    'siteAgent', 'safetyOfficer', 'qualityInspector', 'workDescription',
    'scale', 'ownerCompanyId',
  ];
  const cur = db.sites[idx];
  const next: Site = { ...cur };
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) {
      (next as unknown as Record<string, unknown>)[k] = body[k];
    }
  }
  // 준공 처리 시 진행률 자동 100%
  if (body.status === 'COMPLETED' && next.status === 'COMPLETED') {
    next.progressPercent = 100;
  }
  db.sites[idx] = next;
  saveDb(db);
  return { status: 200, data: { site: next, message: '현장 정보가 갱신되었습니다.' } };
});
route('post', /^\/sites$/, async (req) => {
  const body = req.data as CreateSiteRequest;
  if (!body?.name || !body?.contractKind || !body?.address) {
    return { status: 400, data: { message: '필수 입력값이 누락되었습니다.' } };
  }
  const db = loadDb();
  // 현재 로그인한 사용자의 회사를 owner 로 설정 (없으면 첫 회사 fallback)
  const me = currentUserOf(db);
  const ownerCompanyId = me?.companyId ?? (db.companies?.[0]?.id ?? 'C-001');
  const newSite: Site = {
    id: 'S-' + Date.now().toString().slice(-6),
    name: body.name, contractKind: body.contractKind,
    contractDescription: body.contractDescription,
    contractAmount: body.contractAmount ?? 0,
    contractDate: body.contractDate, startDate: body.startDate, endDate: body.endDate,
    bidNoticeDate: body.bidNoticeDate, insuranceBaseDate: body.insuranceBaseDate,
    client: body.client, zipCode: body.zipCode, address: body.address,
    addressDetail: body.addressDetail, manager: body.manager,
    managerPhone: body.managerPhone, managerFax: body.managerFax,
    siteAgent: body.siteAgent, safetyOfficer: body.safetyOfficer,
    qualityInspector: body.qualityInspector,
    ownerCompanyId,
    progressPercent: 0,
    workerCount: { formwork: 0, masonry: 0, facility: 0, electric: 0 },
    status: 'IN_PROGRESS', createdAt: new Date().toISOString(),
  };
  db.sites = [...(db.sites ?? []), newSite];
  // 새 현장은 GET /sites 가시성 필터 (SiteCompany 멤버십 기반) 를 통과해야 하므로
  // 등록과 동시에 owner 회사의 원도급 SiteCompany 를 생성한다.
  const ownerSc: SiteCompany = {
    id: 'SC-' + Date.now().toString(36).toUpperCase(),
    siteId: newSite.id,
    companyId: ownerCompanyId,
    role: '원도급',
    joinedAt: new Date().toISOString(),
    status: 'ACTIVE',
    contractAmount: newSite.contractAmount,
    startDate: newSite.startDate,
    endDate: newSite.endDate,
    progressPercent: 0,
  };
  db.siteCompanies = [...(db.siteCompanies ?? []), ownerSc];
  saveDb(db);
  const res: SiteCreateResponse = { site: newSite, message: '현장이 정상 등록되었습니다.' };
  return { status: 201, data: res };
});

route('get', /^\/foremen$/, async (req) => {
  const db = loadDb();
  const siteId = req.params?.siteId as string | undefined;
  // companyWide=1 → SITE 모드 사용자도 회사 전체 풀 (자기 회사 SiteCompany 모두) 반환
  // 비번(off-duty) 반장 풀이 사이트 제한 없이 회사 단위로 보여야 다른 현장 비번도 활용 가능
  const companyWide = req.params?.companyWide === '1' || req.params?.companyWide === 'true';
  const me = currentUserOf(db);
  const all = (db.foremen ?? []).filter((f) => !siteId || f.siteId === siteId);
  let foremen = all;
  if (me) {
    const sitesById = new Map((db.sites ?? []).map((s) => [s.id, s] as const));
    const mySiteCompanyIds = new Set(
      (db.siteCompanies ?? [])
        .filter((sc) => sc.companyId === me.companyId && sc.status === 'ACTIVE')
        .map((sc) => sc.id),
    );
    const isVisibleForeman = (f: Foreman): boolean => {
      const iAmSiteOwner = sitesById.get(f.siteId)?.ownerCompanyId === me.companyId;
      // SITE 모드 + companyWide 미지정 → 자기 site 한정
      if (me.assignedSiteId && me.assignedSiteId !== 'ALL' && !companyWide) {
        if (f.siteId !== me.assignedSiteId) return false;
      }
      if (iAmSiteOwner) return true;
      return !!f.siteCompanyId && mySiteCompanyIds.has(f.siteCompanyId);
    };
    foremen = all.filter(isVisibleForeman);
  }
  const res: ListForemenResponse = { foremen };
  return { status: 200, data: res };
});
route('post', /^\/foremen\/batch$/, async (req) => {
  const body = req.data as CreateForemenRequest;
  if (!body?.siteId || !Array.isArray(body?.foremen) || body.foremen.length === 0) {
    return { status: 400, data: { message: '현장과 1명 이상의 반장 정보가 필요합니다.' } };
  }
  const db = loadDb();
  // 등록자의 회사 → siteCompanyId 자동 매핑
  const me = currentUserOf(db);
  const sc = (db.siteCompanies ?? []).find(
    (x) => x.siteId === body.siteId && x.companyId === me?.companyId && x.status === 'ACTIVE',
  );
  if (!sc) {
    return {
      status: 403,
      data: { message: '이 현장에 우리 회사가 합류되어 있지 않습니다.' },
    };
  }
  const created: Foreman[] = [];
  const failures: CreateForemenResponse['failures'] = [];
  for (const item of body.foremen) {
    if (!item.name || !item.phone) { failures.push({ ...item, reason: '성명/전화번호가 비었습니다.' }); continue; }
    if (!/^0\d{1,2}-\d{3,4}-\d{4}$/.test(item.phone)) { failures.push({ ...item, reason: '전화번호 형식이 올바르지 않습니다.' }); continue; }
    const f: Foreman = {
      id: 'F-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name: item.name, phone: item.phone, siteId: body.siteId,
      siteCompanyId: sc.id,
      role: item.role,
      notifyChannel: body.channel,
      invitedAt: new Date().toISOString(), registered: false,
    };
    created.push(f);
  }
  db.foremen = [...(db.foremen ?? []), ...created];
  saveDb(db);
  const res: CreateForemenResponse = { created, failures };
  return { status: 201, data: res };
});

/**
 * 반장 삭제 — 가입 대기 「초대 취소」 또는 활성 반장 제거.
 *  팀원 중 이 반장을 foremanId 로 가진 행은 foremanId 를 비워 「현장담당자 직접 관리」로 fallback.
 */
route('delete', /^\/foremen\/([^/]+)$/, async (req) => {
  const m = (req.url ?? '').match(/^\/foremen\/([^/]+)$/);
  const id = m?.[1];
  if (!id) return { status: 400, data: { message: '반장 ID 가 필요합니다.' } };
  const db = loadDb();
  const idx = (db.foremen ?? []).findIndex((f) => f.id === id);
  if (idx === -1) {
    return { status: 404, data: { message: '해당 반장을 찾을 수 없습니다.' } };
  }
  db.foremen = (db.foremen ?? []).filter((f) => f.id !== id);
  // 이 반장을 책임자로 지정한 멤버들은 foremanId 제거 + assignedToSiteManager = true
  db.members = (db.members ?? []).map((m) =>
    m.foremanId === id
      ? { ...m, foremanId: undefined, assignedToSiteManager: true }
      : m,
  );
  saveDb(db);
  return { status: 200, data: { deleted: true, foremanId: id } };
});

/* ───────── ForemanSite (반장 × 현장 다대다) ───────── */
route('get', /^\/foreman-sites$/, async (req) => {
  const db = loadDb();
  const all = ((db as any).foremanSites ?? []) as ForemanSite[];
  const foremanId = req.params?.foremanId as string | undefined;
  const siteId = req.params?.siteId as string | undefined;
  const includeEnded = req.params?.includeEnded === '1' || req.params?.includeEnded === 'true';
  let rows = all;
  if (foremanId) rows = rows.filter((r) => r.foremanId === foremanId);
  if (siteId) rows = rows.filter((r) => r.siteId === siteId);
  if (!includeEnded) rows = rows.filter((r) => r.status !== 'TERMINATED');
  const res: ListForemanSitesResponse = { foremanSites: rows };
  return { status: 200, data: res };
});

route('post', /^\/foreman-sites$/, async (req) => {
  const body = req.data as Partial<ForemanSite>;
  if (!body?.foremanId || !body?.siteId) {
    return { status: 400, data: { message: 'foremanId, siteId 필수' } };
  }
  const db = loadDb();
  // companyId 가 비어 있으면 추론:
  //  1) 반장의 defaultCompanyId
  //  2) 해당 현장 owner 회사
  //  3) 해당 현장에 ACTIVE 인 SiteCompany 첫 번째
  let companyId = body.companyId?.trim();
  if (!companyId) {
    const f = (db.foremen ?? []).find((x) => x.id === body.foremanId);
    companyId = f?.defaultCompanyId;
  }
  if (!companyId) {
    const site = (db.sites ?? []).find((s) => s.id === body.siteId);
    companyId = site?.ownerCompanyId;
  }
  if (!companyId) {
    const fallback = (db.siteCompanies ?? []).find(
      (x) => x.siteId === body.siteId && x.status === 'ACTIVE',
    );
    companyId = fallback?.companyId;
  }
  if (!companyId) {
    return { status: 400, data: { message: '소속 회사를 자동 추론할 수 없습니다. 「소속 회사」를 입력해주세요.' } };
  }
  const list = ((db as any).foremanSites ?? []) as ForemanSite[];
  const newId = 'FS-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  const sc = (db.siteCompanies ?? []).find(
    (x) => x.siteId === body.siteId && x.companyId === companyId && x.status === 'ACTIVE',
  );
  // 새 배정이 isPrimary=true 이면, 같은 반장의 다른 isPrimary 배정을 false 로 내린다.
  const next: ForemanSite[] = body.isPrimary
    ? list.map((r) => (r.foremanId === body.foremanId ? { ...r, isPrimary: false } : r))
    : list.slice();
  const created: ForemanSite = {
    id: newId,
    foremanId: body.foremanId!,
    siteId: body.siteId!,
    companyId,
    siteCompanyId: sc?.id,
    trade: body.trade ?? '기타',
    role: body.role ?? '주반장',
    permissionPreset: body.permissionPreset ?? 'STANDARD',
    permissions: body.permissions,
    startDate: body.startDate ?? localDateStr(),
    endDate: body.endDate ?? localDateStr(new Date(Date.now() + 86_400_000 * 30)),
    dailyWage: body.dailyWage,
    headcount: body.headcount,
    isPrimary: !!body.isPrimary,
    assignedAt: new Date().toISOString(),
    status: 'PENDING',
    note: body.note,
  };
  next.push(created);
  (db as any).foremanSites = next;
  // 반장 status 가 REGISTERED 였으면 ASSIGNED 로 진급
  const fIdx = (db.foremen ?? []).findIndex((f) => f.id === created.foremanId);
  if (fIdx >= 0) {
    const f = db.foremen[fIdx];
    if (f.status === 'REGISTERED' || !f.status) {
      db.foremen[fIdx] = { ...f, status: 'ASSIGNED' };
    }
    // 호환 — 첫 isPrimary 배정이면 siteId 캐시 업데이트
    if (created.isPrimary) {
      db.foremen[fIdx] = { ...db.foremen[fIdx], siteId: created.siteId, siteCompanyId: created.siteCompanyId };
    }
  }
  saveDb(db);
  return { status: 201, data: { foremanSite: created } };
});

route('patch', /^\/foreman-sites\/([^/]+)$/, async (req) => {
  const m = (req.url ?? '').match(/^\/foreman-sites\/([^/]+)$/);
  const id = m?.[1];
  if (!id) return { status: 400, data: { message: 'id 필수' } };
  const db = loadDb();
  const list = ((db as any).foremanSites ?? []) as ForemanSite[];
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) return { status: 404, data: { message: '배정을 찾을 수 없습니다.' } };
  const patch = req.data as Partial<ForemanSite>;
  let next = list.slice();
  // isPrimary 단일성 보장
  if (patch.isPrimary === true) {
    const fid = list[idx].foremanId;
    next = next.map((r) => (r.foremanId === fid ? { ...r, isPrimary: false } : r));
  }
  next[idx] = { ...next[idx], ...patch };
  // 종료 처리 — status === TERMINATED 또는 endedAt 지정 시 endDate 도 today 로 보정
  if (patch.status === 'TERMINATED' && !patch.endedAt) {
    next[idx].endedAt = new Date().toISOString();
  }
  (db as any).foremanSites = next;
  saveDb(db);
  return { status: 200, data: { foremanSite: next[idx] } };
});

route('delete', /^\/foreman-sites\/([^/]+)$/, async (req) => {
  const m = (req.url ?? '').match(/^\/foreman-sites\/([^/]+)$/);
  const id = m?.[1];
  if (!id) return { status: 400, data: { message: 'id 필수' } };
  const db = loadDb();
  const list = ((db as any).foremanSites ?? []) as ForemanSite[];
  (db as any).foremanSites = list.filter((r) => r.id !== id);
  saveDb(db);
  return { status: 200, data: { deleted: true, id } };
});

/* ───────── 반장 누적 KPI ─────────
 *  실제 운영에선 attendance bucket 누적 집계.
 *  여기선 시연을 위해 foremanId 해시 기반 결정값 + Site 의 attendance bucket 최근 데이터 일부 반영.
 */
route('get', /^\/foreman-metrics$/, async (req) => {
  const db = loadDb();
  const foremanId = req.params?.foremanId as string | undefined;
  const list = (db.foremen ?? []).filter((f) => !foremanId || f.id === foremanId);
  const now = new Date().toISOString();
  const metrics: ForemanMetrics[] = list.map((f) => {
    let h = 0;
    for (const c of f.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    // 결정적 시연값 — 등급별 분포
    const baseFace = 0.78 + ((h % 22) / 100); // 0.78 ~ 0.99
    const baseManual = 0.05 + ((h % 18) / 100); // 0.05 ~ 0.22
    const baseGps = 0.85 + ((h % 14) / 100); // 0.85 ~ 0.98
    const today = (h % 9); // 오늘 출역 0~8
    const month = today * 22 + (h % 30);
    const recentManual = h % 4;
    const recentGps = h % 3;
    return {
      foremanId: f.id,
      todayAttendanceCount: f.status === 'ACTIVE' ? today : 0,
      monthAttendanceCount: f.status === 'ACTIVE' || f.status === 'INACTIVE' ? month : 0,
      faceRecognitionRate: Number(baseFace.toFixed(3)),
      manualProcessingRate: Number(baseManual.toFixed(3)),
      gpsValidRate: Number(baseGps.toFixed(3)),
      recentManualCount: recentManual,
      recentGpsMissingCount: recentGps,
      totalAttendanceCount: month + 250 + (h % 100),
      calculatedAt: now,
    };
  });
  return { status: 200, data: { metrics } };
});

route('get', /^\/dashboard\/summary$/, async (req) => {
  const db = loadDb();
  const sites = db.sites ?? [];
  const foremen = db.foremen ?? [];
  const siteId = (req.params?.siteId as string | undefined) ?? sites[0]?.id;
  const current = sites.find((s) => s.id === siteId);
  // 단일 소스 — attendance bucket 의 오늘 체크인 카운트
  const currentAttendedToday = current ? countAttendedToday(current.id) : 0;
  const totalAttendedToday = countAttendedTodayAllSites(db);
  const summary: DashboardSummary = {
    siteCount: sites.length, foremanCount: foremen.length,
    /** 모든 시공중 현장의 오늘 출근 합계 — 대시보드 「오늘 출력 인원」 단일 소스 */
    totalAttendedToday,
    current: current ? {
      site: current,
      foremen: foremen.filter((f) => f.siteId === current.id),
      kpi: {
        progressPercent: current.progressPercent,
        annualPayoutKrw: 5_768_820, pendingPayoutKrw: 6_450_000,
        deductionKrw: 691_180, incomeTaxKrw: 64_640,
        hourFundKrw: 606_540, severanceKrw: 2_850_000,
        attendedToday: currentAttendedToday, activeSites: 0, idleCount: 0,
      },
    } : undefined,
  };
  return { status: 200, data: summary };
});

route('get', /^\/team\/members$/, async (req) => {
  const db = loadDb();
  const params = req.params ?? {};
  const siteId = params.siteId as string | undefined;
  const status = params.status as string | undefined;
  const q = ((params.q as string) ?? '').trim().toLowerCase();
  const me = currentUserOf(db);
  const sitesById = new Map((db.sites ?? []).map((s) => [s.id, s] as const));
  const mySiteCompanyIds = new Set(
    (db.siteCompanies ?? [])
      .filter((sc) => sc.companyId === me?.companyId && sc.status === 'ACTIVE')
      .map((sc) => sc.id),
  );
  const all = db.members ?? [];
  // 회사 멤버 가시성 규칙:
  //  - SITE 사용자: 자기 site 만. 그 site 의 owner 회사 소속이면 모든 회사 멤버 / 아니면 자기 회사 SC 멤버만
  //  - HQ 사용자: 자기 회사 SC 멤버 + 자기 회사가 owner 인 모든 site 의 모든 멤버
  function isVisibleMember(m: TeamMember): boolean {
    if (!me) return true;
    const siteOwnerId = sitesById.get(m.siteId)?.ownerCompanyId;
    const iAmSiteOwner = siteOwnerId === me.companyId;
    if (me.assignedSiteId && me.assignedSiteId !== 'ALL') {
      if (m.siteId !== me.assignedSiteId) return false;
      if (iAmSiteOwner) return true;
      return !!m.siteCompanyId && mySiteCompanyIds.has(m.siteCompanyId);
    }
    // HQ
    if (iAmSiteOwner) return true;
    return !!m.siteCompanyId && mySiteCompanyIds.has(m.siteCompanyId);
  }
  const filtered = all.filter((m) => {
    if (!isVisibleMember(m)) return false;
    if (siteId && m.siteId !== siteId) return false;
    if (status && status !== 'ALL' && m.status !== status) return false;
    if (q) return m.name.toLowerCase().includes(q) || m.phone.includes(q) || m.role.toLowerCase().includes(q);
    return true;
  });
  const totalActive = all.filter((m) => isVisibleMember(m) && m.status === 'ACTIVE').length;
  const res: ListMembersResponse = { members: filtered, totalActive };
  return { status: 200, data: res };
});
route('get', /^\/team\/members\/[^/]+$/, async (req) => {
  const db = loadDb();
  const id = req.url.split('/').pop()!;
  const member = (db.members ?? []).find((m) => m.id === id);
  if (!member) return { status: 404, data: { message: '팀원을 찾을 수 없습니다.' } };
  return { status: 200, data: member };
});
route('post', /^\/team\/members$/, async (req) => {
  const body = req.data as RegisterMemberRequest;
  if (!body?.name || !body?.phone) return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  if (!body.agreedToPersonalInfo) return { status: 400, data: { message: '[PART 1] 개인정보 수집·이용 동의가 필요합니다.' } };
  if (!body.agreedToBiometric) return { status: 400, data: { message: '[PART 2] 얼굴 식별 정보 처리 동의가 필요합니다.' } };
  if (!body.agreedToProxyDevice) return { status: 400, data: { message: '[PART 3] 반장 기기 이용 및 본인 직접 서명 동의가 필요합니다.' } };
  const db = loadDb();
  // 현재 로그인한 사용자의 회사 → siteCompanyId 자동 매핑
  const me = currentUserOf(db);
  const myCompanyId = me?.companyId;
  const hasSite = !!body.siteId;
  // siteCompany 결정 — 현장이 없으면 미소속(대기 인력), 현장이 있는데 합류돼있지 않으면 자동 합류 처리
  let sc: SiteCompany | undefined;
  if (hasSite) {
    sc = (db.siteCompanies ?? []).find(
      (x) => x.siteId === body.siteId && x.companyId === myCompanyId && x.status === 'ACTIVE',
    );
    if (!sc && myCompanyId) {
      // 시연 편의 — 자동 합류 (실제 운영에서는 본사에서 합류를 먼저 처리)
      sc = {
        id: 'SC-' + Date.now().toString(36).toUpperCase(),
        siteId: body.siteId!,
        companyId: myCompanyId,
        role: '하도급',
        joinedAt: new Date().toISOString(),
        status: 'ACTIVE',
      };
      db.siteCompanies = [...(db.siteCompanies ?? []), sc];
    }
  }
  const firstForeman = hasSite
    ? (db.foremen ?? []).find(
        (f) => f.siteId === body.siteId && (!f.siteCompanyId || (sc && f.siteCompanyId === sc.id)),
      )
    : undefined;
  // 우선순위:
  //  1) assignToSiteManager === true → 반장 미배정 (현장담당자가 직접 관리)
  //  2) body.foremanId 명시 → 그 반장
  //  3) 둘 다 없음 → 같은 SiteCompany 의 첫 반장 (기존 폴백, 현장이 있을 때만)
  const assignedForemanId = body.assignToSiteManager
    ? undefined
    : (body.foremanId ?? firstForeman?.id);
  const member: TeamMember = {
    id: 'M-' + Date.now().toString(36).slice(-6).toUpperCase(),
    name: body.name, phone: body.phone, role: body.role, siteId: body.siteId ?? '',
    siteCompanyId: sc?.id,
    foremanId: assignedForemanId,
    assignedToSiteManager: !!body.assignToSiteManager,
    dailyWage: body.dailyWage, idType: body.idType,
    idNumberMasked: maskIdNumber(body.idNumber),
    idNumberRaw: body.idNumber,
    bankName: body.bankName, accountMasked: maskAccount(body.accountNumber),
    accountNumberRaw: body.accountNumber,
    registrationMode: body.mode, status: 'ACTIVE',
    joinedAt: localDateStr(),
    insurance: body.insurance ?? { pension: false, health: false, employment: true, accident: true },
    safetyEduCompleted: body.safetyEduCompleted ?? false,
  };
  db.members = [...(db.members ?? []), member];
  saveDb(db);
  const res: RegisterMemberResponse = {
    member,
    notificationSent: body.notifyConsentComplete !== false && body.mode !== 'ONLINE',
    message: '팀원이 정상 등록되었습니다.',
  };
  return { status: 201, data: res };
});
route('post', /^\/team\/online-invite$/, async (req) => {
  const body = req.data as CreateOnlineInviteRequest;
  if (!body?.name || !body?.phone || !body?.siteId) return { status: 400, data: { message: '이름·전화번호·현장이 필요합니다.' } };
  if (!/^0\d{1,2}-\d{3,4}-\d{4}$/.test(body.phone)) return { status: 400, data: { message: '전화번호 형식이 올바르지 않습니다.' } };
  const db = loadDb();
  const inviteId = 'INV-' + Date.now().toString(36).slice(-6).toUpperCase();
  const inviteToken = Math.random().toString(36).slice(2, 14);
  const inviteUrl = 'https://akoma.co.kr/r/' + inviteToken;
  const smsSentAt = new Date().toISOString();
  db.invites = [...(db.invites ?? []), { inviteId, inviteToken, name: body.name, phone: body.phone, siteId: body.siteId, smsSentAt }];
  saveDb(db);
  const res: CreateOnlineInviteResponse = { inviteId, inviteToken, inviteUrl, smsSentAt };
  return { status: 201, data: res };
});
route('delete', /^\/team\/members\/[^/]+$/, async (req) => {
  const db = loadDb();
  const id = req.url.split('/').pop()!;
  const before = db.members?.length ?? 0;
  db.members = (db.members ?? []).filter((m) => m.id !== id);
  saveDb(db);
  return { status: 200, data: { memberId: id, deleted: (db.members?.length ?? 0) < before } };
});
route('patch', /^\/team\/members\/[^/]+$/, async (req) => {
  const db = loadDb();
  const id = req.url.split('/').pop()!;
  const body = (req.data ?? {}) as Record<string, unknown>;
  const idx = (db.members ?? []).findIndex((m) => m.id === id);
  if (idx < 0) {
    const err: any = new Error('member not found');
    err.response = { status: 404, data: { message: '팀원을 찾을 수 없습니다.' } };
    throw err;
  }
  const cur = db.members![idx];
  const b = body as any;
  const next: TeamMember = {
    ...cur,
    ...(b.name !== undefined ? { name: String(b.name) } : {}),
    ...(b.phone !== undefined ? { phone: String(b.phone) } : {}),
    ...(b.role !== undefined ? { role: b.role } : {}),
    ...(b.dailyWage !== undefined ? { dailyWage: Number(b.dailyWage) } : {}),
    ...(b.siteId !== undefined ? { siteId: String(b.siteId) } : {}),
    ...(b.foremanId !== undefined
      ? { foremanId: b.foremanId ? String(b.foremanId) : undefined }
      : {}),
    ...(b.assignToSiteManager !== undefined
      ? {
          assignedToSiteManager: !!b.assignToSiteManager,
          // 현장담당자 직접 관리로 전환 시 반장 ID 명시 해제
          ...(b.assignToSiteManager ? { foremanId: undefined } : {}),
        }
      : {}),
    ...(b.status !== undefined ? { status: b.status } : {}),
    ...(b.bankName !== undefined ? { bankName: String(b.bankName) } : {}),
    ...(b.accountNumber !== undefined && b.accountNumber !== ''
      ? {
          accountMasked: maskAccount(String(b.accountNumber)),
          accountNumberRaw: String(b.accountNumber),
        }
      : {}),
    ...(b.idNumber !== undefined && b.idNumber !== ''
      ? {
          idNumberMasked: maskIdNumber(String(b.idNumber)),
          idNumberRaw: String(b.idNumber),
        }
      : {}),
    ...(b.idType !== undefined ? { idType: b.idType } : {}),
    ...(b.insurance !== undefined ? { insurance: b.insurance } : {}),
    ...(b.safetyEduCompleted !== undefined ? { safetyEduCompleted: !!b.safetyEduCompleted } : {}),
    ...(b.leftAt !== undefined ? { leftAt: b.leftAt || undefined } : {}),
  };
  db.members![idx] = next;
  saveDb(db);
  return {
    status: 200,
    data: { member: next, message: '팀원 정보가 수정되었습니다.' },
  };
});
route('post', /^\/team\/uploads$/, async () => {
  const id = 'IMG-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  return { status: 200, data: { imageId: id, url: '/mock/img/' + id + '.jpg' } };
});

function maskIdNumber(raw?: string) {
  if (!raw) return '------';
  const cleaned = raw.replace(/\D/g, '');
  if (cleaned.length < 7) return raw;
  return cleaned.slice(0, 6) + '-' + cleaned[6] + '******';
}
function maskAccount(raw?: string) {
  if (!raw) return '***-***-****';
  const parts = raw.replace(/\s/g, '').split('-');
  if (parts.length === 0) return raw;
  return parts.map((p, i) => (i === 0 ? p : i === parts.length - 1 ? p : '***')).join('-');
}

route('get', /^\/wage\/month$/, async (req) => {
  const db = loadDb();
  const params = req.params ?? {};
  const siteId = (params.siteId as string) ?? db.sites?.[0]?.id ?? '';
  const yearMonth = (params.yearMonth as string) ?? localYearMonth();
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr); const month = Number(mStr);
  const members = (db.members ?? []).filter((m) => m.siteId === siteId);
  const attBucket = loadAttendanceBucket(siteId, yearMonth);
  const rows: WageRow[] = members.map((m) => {
    let totalGongsu = 0;
    let workDays = 0;
    for (const r of Object.values(attBucket.records)) {
      if (r.memberId !== m.id) continue;
      if (r.gongsu > 0) { totalGongsu += r.gongsu; workDays += 1; }
    }
    const age = 35;
    const w = calcWageBreakdown({ dailyWage: m.dailyWage, totalGongsu, workDays, age });
    const accident = 0;
    const dedTotal = w.incomeTax + w.localTax + w.health + w.longCare + w.pension + w.employment + accident;
    const severance = Math.round((w.basePay * (1 / 12)) / 1000) * 1000;
    return {
      memberId: m.id, memberName: m.name, idNumberMasked: m.idNumberMasked, role: m.role,
      workDays, dailyWage: m.dailyWage, baseAmount: w.basePay,
      deductionPension: w.pension,
      deductionHealth: w.health + w.longCare,
      deductionEmployment: w.employment,
      deductionAccident: accident,
      deductionIncomeTax: w.incomeTax,
      deductionLocalTax: w.localTax,
      deductionTotal: dedTotal,
      netAmount: w.grossPay - dedTotal,
      severanceAccrued: severance,
    };
  });
  const byRoleMap = new Map<string, { count: number; days: number; net: number }>();
  for (const r of rows) {
    const cur = byRoleMap.get(r.role) ?? { count: 0, days: 0, net: 0 };
    byRoleMap.set(r.role, { count: cur.count + 1, days: cur.days + r.workDays, net: cur.net + r.netAmount });
  }
  const totalDays = rows.reduce((s, r) => s + r.workDays, 0);
  const totalBase = rows.reduce((s, r) => s + r.baseAmount, 0);
  const totalDeduction = rows.reduce((s, r) => s + r.deductionTotal, 0);
  const totalNet = rows.reduce((s, r) => s + r.netAmount, 0);
  const totalSeverance = rows.reduce((s, r) => s + r.severanceAccrued, 0);
  const summary: WageMonthSummary = {
    year, month, totalDays, totalBase, totalDeduction, totalNet, totalSeverance,
    byRole: Array.from(byRoleMap.entries()).map(([role, v]) => ({ role: role as WageRow['role'], ...v })),
    rows,
  };
  return { status: 200, data: summary };
});
route('get', /^\/severance\/month$/, async (req) => {
  const db = loadDb();
  const params = req.params ?? {};
  const siteId = (params.siteId as string) ?? db.sites?.[0]?.id ?? '';
  const yearMonth = (params.yearMonth as string) ?? localYearMonth();
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr); const month = Number(mStr);
  const members = (db.members ?? []).filter((m) => m.siteId === siteId);

  // ── 데이터 일관성 정책 ──────────────────────────────────────
  // 퇴직금은 출퇴근 데이터(att:{siteId}:* 모든 월 버킷)에서 직접 누적 출력일수를
  // 집계해서 산출합니다. 임의(Math.random) 값을 쓰지 않고, 출퇴근현황·노임비
  // 페이지가 보는 동일 소스를 사용 → 세 페이지 숫자가 항상 일치.
  // ─────────────────────────────────────────────────────────────
  const daysByMember = new Map<string, number>();
  const prefix = `att:${siteId}:`;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    try {
      const b = JSON.parse(localStorage.getItem(k) ?? '') as AttendanceCacheBucket;
      for (const r of Object.values(b.records ?? {})) {
        if (r && r.gongsu > 0) {
          daysByMember.set(r.memberId, (daysByMember.get(r.memberId) ?? 0) + 1);
        }
      }
    } catch { /* ignore */ }
  }

  const rows: SeveranceRow[] = members.map((m) => {
    const totalDays = daysByMember.get(m.id) ?? 0;
    // 1/12 법정 적립 — 출력일수 × 일당 ÷ 12 (천원 단위 절상)
    const accruedTotal = totalDays > 0
      ? Math.round((totalDays * m.dailyWage) / 12 / 1000) * 1000
      : 0;
    // 지급액은 별도 트랜잭션 발생 전엔 0 (랜덤 X)
    const paid = 0;
    return {
      memberId: m.id, memberName: m.name, idNumberMasked: m.idNumberMasked, role: m.role,
      joinedAt: m.joinedAt, dailyWage: m.dailyWage,
      totalWorkDays: totalDays, accruedTotal, paidTotal: paid,
      balance: accruedTotal - paid, lastPaidAt: undefined,
    };
  });
  // 단일 소스 — attendance bucket 오늘 체크인 카운트 (대시보드/출퇴근과 동일)
  const summary: SeveranceMonthSummary = {
    year, month, attendedToday: countAttendedToday(siteId),
    totalAccrued: rows.reduce((s, r) => s + r.accruedTotal, 0),
    totalPaid: rows.reduce((s, r) => s + r.paidTotal, 0),
    totalBalance: rows.reduce((s, r) => s + r.balance, 0),
    rows,
  };
  return { status: 200, data: summary };
});
route('post', /^\/wage\/export$/, async () => {
  const res: PayoutDispatchResponse = { count: 0, channel: 'EXCEL', exportedAt: new Date().toISOString() };
  return { status: 200, data: res };
});
route('post', /^\/wage\/dispatch$/, async (req) => {
  const body = req.data as { channel?: string };
  const res: PayoutDispatchResponse = { count: 0, channel: (body.channel as PayoutDispatchResponse['channel']) ?? 'KAKAO', exportedAt: new Date().toISOString() };
  return { status: 200, data: res };
});

interface AttendanceCacheBucket {
  yearMonth: string; siteId: string;
  records: Record<string, AttendanceRecord>;
  audit: AuditLogEntry[];
  /** 마감된 일자 목록 (date 'YYYY-MM-DD' → DayClose) — 키 미존재 = OPEN */
  dayCloses?: Record<string, DayClose>;
  /** 월 단위 마감 상태 — undefined 면 OPEN */
  monthClose?: MonthClose;
}
function attendanceBucketKey(siteId: string, yearMonth: string) {
  return 'att:' + siteId + ':' + yearMonth;
}
function loadAttendanceBucket(siteId: string, yearMonth: string): AttendanceCacheBucket {
  const key = attendanceBucketKey(siteId, yearMonth);
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  const seed = seedAttendance(siteId, yearMonth);
  localStorage.setItem(key, JSON.stringify(seed));
  return seed;
}
function saveAttendanceBucket(b: AttendanceCacheBucket) {
  localStorage.setItem(attendanceBucketKey(b.siteId, b.yearMonth), JSON.stringify(b));
}

/**
 * 단일 소스의 진실 — 오늘 한 현장의 출근 인원 (체크인 한 사람 수)
 * 대시보드/출퇴근/퇴직금이 모두 이 함수를 거친다.
 *
 *  ⚠ 시간대 주의 — record.checkInAt 은 UTC ISO 문자열이라
 *     `checkInAt.slice(0,10)` 으로 자르면 한국 시간 7시 = UTC 전날 22시 → 어제 날짜가 나옴.
 *     records 의 `date` 필드는 시드 시점에 로컬 날짜로 저장되므로 그것을 사용.
 *     todayStr 도 toISOString() 대신 로컬 Date 컴포넌트로 직접 조립.
 */
function countAttendedToday(siteId: string): number {
  const now = new Date();
  const todayStr =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0');
  const yearMonth = todayStr.slice(0, 7);
  const bucket = loadAttendanceBucket(siteId, yearMonth);
  let n = 0;
  for (const r of Object.values(bucket.records)) {
    if (!r) continue;
    if (r.date === todayStr && r.checkInAt) n++;
  }
  return n;
}

// ───────── 지오펜싱 헬퍼 ─────────

/** 도시명 → 대표 좌표 (시드용 mock geocoding) */
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  서울: { lat: 37.5665, lng: 126.9780 },
  인천: { lat: 37.4563, lng: 126.7052 },
  부산: { lat: 35.1796, lng: 129.0756 },
  대구: { lat: 35.8714, lng: 128.6014 },
  대전: { lat: 36.3504, lng: 127.3845 },
  광주: { lat: 35.1595, lng: 126.8526 },
  울산: { lat: 35.5384, lng: 129.3114 },
  세종: { lat: 36.4801, lng: 127.2890 },
  수원: { lat: 37.2636, lng: 127.0286 },
  성남: { lat: 37.4201, lng: 127.1262 },
  화성: { lat: 37.1995, lng: 126.8311 },
  창원: { lat: 35.2280, lng: 128.6811 },
  제주: { lat: 33.4996, lng: 126.5312 },
};

/** 시드 시점 도시 기반 기본 geofence — 약간의 jitter 로 현장 좌표 흩뿌림 */
function defaultGeofenceForCity(city: string): {
  lat: number;
  lng: number;
  radiusM: number;
  gpsTolerance: number;
  locationRequired: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
  outOfBoundsPolicy: 'BLOCK' | 'WARN' | 'ALLOW';
} {
  const base = CITY_COORDS[city] ?? { lat: 37.5665, lng: 126.9780 };
  // 도시 안에서 약간의 분산 (±0.05도 ≈ 5km)
  const jitterLat = ((Math.random() - 0.5) * 0.06);
  const jitterLng = ((Math.random() - 0.5) * 0.06);
  return {
    lat: Number((base.lat + jitterLat).toFixed(6)),
    lng: Number((base.lng + jitterLng).toFixed(6)),
    radiusM: 100,
    gpsTolerance: 30,
    locationRequired: 'RECOMMENDED',
    outOfBoundsPolicy: 'WARN',
  };
}

/** Haversine — 두 좌표 사이 거리 (m) */
function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000; // 지구 반지름 (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

/**
 * 인증 결과 판정 — 현장 정책 + 측정된 좌표·정확도로 판단
 *  · 좌표 없음 → NO_LOCATION
 *  · 정확도 > tolerance → LOW_ACCURACY
 *  · 거리 ≤ radius → INSIDE
 *  · 거리 > radius → OUTSIDE
 */
function evaluateGeofence(
  geofence: { lat: number; lng: number; radiusM: number; gpsTolerance: number },
  loc?: { lat: number; lng: number; accuracy: number },
): { result: 'INSIDE' | 'OUTSIDE' | 'NO_LOCATION' | 'LOW_ACCURACY'; distanceM?: number } {
  if (!loc) return { result: 'NO_LOCATION' };
  if (loc.accuracy > geofence.gpsTolerance) return { result: 'LOW_ACCURACY' };
  const distanceM = haversineMeters(geofence, loc);
  if (distanceM <= geofence.radiusM) return { result: 'INSIDE', distanceM };
  return { result: 'OUTSIDE', distanceM };
}

/** 모든 (시공중) 현장의 오늘 출근 합계 — 대시보드 KPI 헬퍼 */
function countAttendedTodayAllSites(db: ReturnType<typeof loadDb>): number {
  const sites = (db.sites ?? []).filter((s) => s.status !== 'COMPLETED');
  let total = 0;
  for (const s of sites) total += countAttendedToday(s.id);
  return total;
}

/** 그 일자가 마감됐는지 — true 면 변경 불가 */
function isDateClosed(bucket: AttendanceCacheBucket, date: string): boolean {
  if (bucket.monthClose?.status === 'CLOSED') return true;
  return bucket.dayCloses?.[date]?.status === 'CLOSED';
}
/** 마감 차단 응답 헬퍼 */
function closedResponse(date: string): MockResult {
  return {
    status: 423, // Locked
    data: {
      message: `${date} 는 마감되어 변경할 수 없습니다. 본사에 재개봉을 요청하세요.`,
    },
  };
}
/** 로컬 시간대 기준 YYYY-MM-DD — toISOString() 은 UTC 라서 한국 새벽엔 어제 날짜를 반환. */
function localDateStr(d: Date = new Date()): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function deterministicRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h / 0xffffffff;
}
function randInt(seed: string, min: number, max: number): number {
  const r = deterministicRandom(seed);
  return Math.floor(min + r * (max - min + 1));
}
function seedAttendance(siteId: string, yearMonth: string): AttendanceCacheBucket {
  const db = loadDb();
  const members = (db.members ?? []).filter((m) => m.siteId === siteId);
  const foremenById = new Map((db.foremen ?? []).map((f) => [f.id, f] as const));
  const site = (db.sites ?? []).find((s) => s.id === siteId);
  const geofence = site?.geofence;
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr); const month = Number(mStr);
  // v42 — 2026-04 / 2026-05 만. 4·5월 데이터로 일일/월별 출역을 비교 시연.
  const SEED_ALLOWED_MONTHS = new Set(['2026-04', '2026-05']);
  if (!SEED_ALLOWED_MONTHS.has(yearMonth)) {
    return { records: {}, audit: [], yearMonth, siteId };
  }
  const lastDay = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDay = today.getDate();
  const records: Record<string, AttendanceRecord> = {};
  const audit: AuditLogEntry[] = [];
  // v42 — 오늘 출근할 10명 결정 (해시 기반 결정적 선택)
  //  · 시드 멤버(M-NNN)만 후보, status=PENDING 제외
  //  · 오늘 날짜를 시드로 score 계산 → score 낮은 순 10명만 오늘 출근
  const todayKey = localDateStr(today);
  // v45 — 10명 전원 오늘 출근 (사이트 무관 전체 명단)
  const todayAttendeeIds = new Set(
    members.filter((m) => m.status !== 'PENDING' && /^M-\d{3}$/.test(m.id)).map((m) => m.id),
  );

  for (const m of members) {
    // PENDING 상태(가입 대기·미소속) 워커는 아직 출역 시작 X — 출근 데이터 생성 스킵
    if (m.status === 'PENDING') continue;
    // 시드 멤버만 자동 출석 시뮬레이션 — id 가 'M-NNN' 패턴(M-001~M-099)인 경우만.
    // 신규 등록(register API) 멤버 id 는 'M-XXXXXX' (timestamp 기반) 라 패턴 불일치 → 스킵.
    // 결과: 새로 등록한 팀원은 캘린더가 빈 상태로 시작, 관리자가 수동으로 입력해야 함.
    const isSeedMember = /^M-\d{3}$/.test(m.id);
    if (!isSeedMember) continue;
    // ─── 워커별 출근율 변동 (v42) ───
    // 16일 cap 안에서 자연스럽게 분포되도록 출근율 하향 조정
    //  · 출근율 50~75% → 평일 22일 기준 11~16일 (16일 cap 도달자 일부)
    //  · 토요일은 출근 확률 더 낮춤 (10~40%)
    let mh = 0;
    for (const c of m.id) mh = (mh * 33 + c.charCodeAt(0)) >>> 0;
    const attendanceRate = 0.55 + ((mh % 26) / 100);   // 0.55 ~ 0.80
    const satRate = 0.15 + (((mh >> 7) % 41) / 100);   // 0.15 ~ 0.55
    let attendedDays = 0;
    const MAX_ATTENDED_DAYS = 18;

    // 멤버의 입사일 — 입사 전 날짜는 출석 시드 X
    const memberJoinDate = m.joinedAt ? new Date(m.joinedAt + 'T00:00:00') : null;
    for (let d = 1; d <= lastDay; d++) {
      const date = new Date(year, month - 1, d);
      const dow = date.getDay();
      const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (isCurrentMonth && d > todayDay) continue;
      if (dow === 0) continue;
      // 입사일 이전 날짜는 출석 데이터 생성 X (신규 등록 즉시 과거 데이터 노출 방지)
      if (memberJoinDate && date < memberJoinDate) continue;
      // 토요일 — 워커별 satRate 만큼만 출근
      if (dow === 6 && deterministicRandom(m.id + '-' + dateStr + '-sat') > satRate) continue;
      const isToday = isCurrentMonth && d === todayDay;
      const isTodayGuaranteedAttendee = isToday && todayAttendeeIds.has(m.id);

      // 오늘 (현재 월·현재 일) 선정 외 워커 → 결석 처리
      if (isToday && !isTodayGuaranteedAttendee) {
        const r: AttendanceRecord = {
          id: 'R-' + m.id + '-' + dateStr, date: dateStr,
          memberId: m.id, memberName: m.name, role: m.role, siteId,
          checkInAt: null, checkOutAt: null,
          checkInMethod: null, checkOutMethod: null,
          checkInScore: null, checkOutScore: null,
          status: 'ABSENT', workedMinutes: 0, gongsu: 0,
          dailyWage: m.dailyWage, payAmount: 0,
        };
        records[m.id + '|' + dateStr] = r;
        continue;
      }

      // v45-fix: 18일 cap 은 「오늘 보장 출근자」도 함께 지킴.
      // 이미 cap 도달한 워커는 오늘이라도 ABSENT 처리 (cap 위반 방지).
      if (attendedDays >= MAX_ATTENDED_DAYS) {
        const r: AttendanceRecord = {
          id: 'R-' + m.id + '-' + dateStr, date: dateStr,
          memberId: m.id, memberName: m.name, role: m.role, siteId,
          checkInAt: null, checkOutAt: null,
          checkInMethod: null, checkOutMethod: null,
          checkInScore: null, checkOutScore: null,
          status: 'ABSENT', workedMinutes: 0, gongsu: 0,
          dailyWage: m.dailyWage, payAmount: 0,
        };
        records[m.id + '|' + dateStr] = r;
        continue;
      }

      // 보장 출근자는 랜덤 결석 체크 우회 — 「오늘」은 확정 출근
      if (!isTodayGuaranteedAttendee) {
        if (deterministicRandom(m.id + '-' + dateStr + '-abs') > attendanceRate) {
          const r: AttendanceRecord = {
            id: 'R-' + m.id + '-' + dateStr, date: dateStr,
            memberId: m.id, memberName: m.name, role: m.role, siteId,
            checkInAt: null, checkOutAt: null,
            checkInMethod: null, checkOutMethod: null,
            checkInScore: null, checkOutScore: null,
            status: 'ABSENT', workedMinutes: 0, gongsu: 0,
            dailyWage: m.dailyWage, payAmount: 0,
          };
          records[m.id + '|' + dateStr] = r;
          continue;
        }
      }
      attendedDays++;
      // 출근시간 분포 — 현장 근로자 대다수는 7:00 이전 도착 (5~20분 일찍).
      //  · 이전: -10~+35 → 78% 지각 (비현실적)
      //  · 수정: -20~+5 → 약 80% 정시·조기 출근, 20% 만 지각 (5분 이내 미세 지각 포함)
      const inOffsetMin = randInt(m.id + '-' + dateStr + '-in', -20, 5);
      const checkInAt = new Date(year, month - 1, d, 7, inOffsetMin).toISOString();
      // 퇴근시간 분포 — 대다수 정시(15:00 전후), 일부 연장근무/조퇴
      //  · 이전 65% 정시 + 28% 야근 + 7% 조퇴 (12시) → 가끔 조퇴자 여러 명 발생
      //  · 수정: 정시 비율 75% 로 상향, 조퇴 5% 로 감소
      let outBase = 15 * 60;
      const scenario = deterministicRandom(m.id + '-' + dateStr + '-scen');
      if (scenario < 0.75)      outBase = 15 * 60 + randInt(m.id + '-' + dateStr + '-std', -5, 25);  // 75% 정시 14:55~15:25
      else if (scenario < 0.90) outBase = 19 * 60 + randInt(m.id + '-' + dateStr + '-ot1', -15, 30); // 15% 야근 (~19시)
      else if (scenario < 0.95) outBase = 23 * 60 + randInt(m.id + '-' + dateStr + '-ot2', -15, 15); // 5% 심야 (~23시)
      else                       outBase = 12 * 60 + randInt(m.id + '-' + dateStr + '-half', -15, 30); // 5% 반일 (~12시)
      const outH = Math.floor(outBase / 60);
      const outM = outBase % 60;
      const checkOutAt = new Date(year, month - 1, d, outH, outM).toISOString();
      // v45 — M-008/M-009/M-010 = MANUAL (3명), 나머지 7명은 FACE → 70/30%
      const memNumMatch = m.id.match(/M-(\d+)/);
      const memNum = memNumMatch ? Number(memNumMatch[1]) : 0;
      const manual = memNum >= 8 && memNum <= 10;
      const inMethod = manual ? 'MANUAL' : 'FACE';
      const outMethod = manual ? 'MANUAL' : 'FACE';
      const reason = manual ? '카메라 일시 장애로 반장이 직접 처리' : undefined;
      const { workedMinutes, gongsu } = calcGongsu(checkInAt, checkOutAt);
      const status: AttendanceRecord['status'] = isLate(checkInAt) ? 'LATE' : (isEarly(checkOutAt) && gongsu < 1 ? 'EARLY' : 'NORMAL');
      // ── 지오펜싱 시뮬레이션 — manual 은 NO_LOCATION (현장 직접 처리), FACE 는 INSIDE 가 대부분 ──
      let geofenceResult: 'INSIDE' | 'OUTSIDE' | 'NO_LOCATION' | 'LOW_ACCURACY' | undefined;
      let checkInLocation: { lat: number; lng: number; accuracy: number; capturedAt: string } | undefined;
      let distanceFromSiteM: number | undefined;
      if (geofence) {
        const geoSeed = deterministicRandom(m.id + '-' + dateStr + '-geo');
        if (manual) {
          // 반장 대신 처리 — 위치정보 없음
          geofenceResult = 'NO_LOCATION';
        } else if (geoSeed < 0.85) {
          // 정상 — 반경 내 (작은 jitter)
          const lat = geofence.lat + (deterministicRandom(m.id + '-' + dateStr + '-lat') - 0.5) * 0.0008;
          const lng = geofence.lng + (deterministicRandom(m.id + '-' + dateStr + '-lng') - 0.5) * 0.0008;
          const accuracy = 5 + Math.round(deterministicRandom(m.id + '-' + dateStr + '-acc') * 15);
          checkInLocation = { lat, lng, accuracy, capturedAt: checkInAt };
          distanceFromSiteM = haversineMeters(geofence, { lat, lng });
          geofenceResult = 'INSIDE';
        } else if (geoSeed < 0.92) {
          // 반경 밖 — 인증 시도 (다른 곳에서 출근 시도)
          const offsetLat = (deterministicRandom(m.id + '-' + dateStr + '-offlat') - 0.5) * 0.005;
          const offsetLng = (deterministicRandom(m.id + '-' + dateStr + '-offlng') - 0.5) * 0.005;
          const lat = geofence.lat + offsetLat;
          const lng = geofence.lng + offsetLng;
          const accuracy = 8 + Math.round(deterministicRandom(m.id + '-' + dateStr + '-acc2') * 10);
          checkInLocation = { lat, lng, accuracy, capturedAt: checkInAt };
          distanceFromSiteM = haversineMeters(geofence, { lat, lng });
          geofenceResult = 'OUTSIDE';
        } else if (geoSeed < 0.97) {
          // GPS 오차범위 초과 — 정확도 매우 나쁨 (실내·터널·다층빌딩)
          const lat = geofence.lat + (deterministicRandom(m.id + '-' + dateStr + '-llat') - 0.5) * 0.0008;
          const lng = geofence.lng + (deterministicRandom(m.id + '-' + dateStr + '-llng') - 0.5) * 0.0008;
          const accuracy = geofence.gpsTolerance + 20 + Math.round(deterministicRandom(m.id + '-' + dateStr + '-lacc') * 100);
          checkInLocation = { lat, lng, accuracy, capturedAt: checkInAt };
          geofenceResult = 'LOW_ACCURACY';
        } else {
          // 위치정보 미수집 — 사용자가 권한 거부
          geofenceResult = 'NO_LOCATION';
        }
      }

      const r: AttendanceRecord = {
        id: 'R-' + m.id + '-' + dateStr, date: dateStr,
        memberId: m.id, memberName: m.name, role: m.role, siteId,
        checkInAt, checkOutAt,
        checkInMethod: inMethod, checkOutMethod: outMethod,
        checkInScore: manual ? null : 0.92 + (deterministicRandom(m.id + '-' + dateStr + '-score') * 0.07),
        checkOutScore: manual ? null : 0.92 + (deterministicRandom(m.id + '-' + dateStr + '-score2') * 0.07),
        manualReason: reason, status, workedMinutes, gongsu,
        dailyWage: m.dailyWage, payAmount: Math.round(m.dailyWage * gongsu),
        checkInLocation,
        geofenceResult,
        distanceFromSiteM,
      };
      records[m.id + '|' + dateStr] = r;
      if (manual) {
        // 시연 데이터 — 처리자는 그 작업자의 담당 반장(없으면 '본사 공무')
        const handler = m.foremanId ? foremenById.get(m.foremanId)?.name : null;
        audit.push({
          id: 'AUD-' + m.id + '-' + dateStr,
          type: 'MANUAL_CHECK_IN',
          memberIds: [m.id], memberNames: [m.name],
          reason: reason!, performedBy: handler ?? '본사 공무', performedAt: checkInAt,
        });
      }
    }
  }

  // ─── 현장별 「오늘」 가시성 보강 ───
  //  · 시연 시 현장별로 인증관리/일일확정 화면에 충분한 record 가 보이도록 보강.
  //  · 보장 기준 (오늘 한정):
  //     · 얼굴인식 + GPS-INSIDE 정상 record 최소 5명
  //     · GPS 오류(OUTSIDE/LOW_ACCURACY/NO_LOCATION) record 1~2명
  //     · 수기입력(MANUAL) record 1~2명
  //  · 이미 충분한 분포가 있으면 건드리지 않음 — 기존 deterministic 시드 우선.
  if (isCurrentMonth) {
    const todayStr = year + '-' + String(month).padStart(2, '0') + '-' + String(todayDay).padStart(2, '0');
    const todaySeedMembers = members.filter((m) => m.status !== 'PENDING' && /^M-\d{3}$/.test(m.id));
    type RKind = 'face_ok' | 'face_fail' | 'gps_err' | 'manual';
    const buckets: Record<RKind, AttendanceRecord[]> = { face_ok: [], face_fail: [], gps_err: [], manual: [] };
    for (const m of todaySeedMembers) {
      const k = m.id + '|' + todayStr;
      const r = records[k];
      if (!r || r.status === 'ABSENT') continue;
      if (r.checkInMethod === 'MANUAL') { buckets.manual.push(r); continue; }
      if (r.geofenceResult && r.geofenceResult !== 'INSIDE') { buckets.gps_err.push(r); continue; }
      if (r.checkInMethod === 'FACE' && (r.checkInScore ?? 0) <= 0.7) { buckets.face_fail.push(r); continue; }
      if (r.checkInMethod === 'FACE') { buckets.face_ok.push(r); continue; }
    }
    // ABSENT 인 사람을 우선적으로 「오늘」 출근시켜 분포를 맞춤. 그 다음에 수동/GPS 오류로 변환.
    const absentToday = todaySeedMembers
      .map((m) => ({ m, r: records[m.id + '|' + todayStr] }))
      .filter(({ r }) => !r || r.status === 'ABSENT');

    function ensureAttended(m: typeof members[number]): AttendanceRecord {
      const k = m.id + '|' + todayStr;
      let r = records[k];
      if (!r || r.status === 'ABSENT') {
        const inOffsetMin = randInt(m.id + '-' + todayStr + '-fix-in', -10, 35);
        const checkInAt = new Date(year, month - 1, todayDay, 7, inOffsetMin).toISOString();
        const outBase = 15 * 60 + randInt(m.id + '-' + todayStr + '-fix-out', -10, 30);
        const checkOutAt = new Date(year, month - 1, todayDay, Math.floor(outBase / 60), outBase % 60).toISOString();
        const { workedMinutes, gongsu } = calcGongsu(checkInAt, checkOutAt);
        r = {
          id: 'R-' + m.id + '-' + todayStr, date: todayStr,
          memberId: m.id, memberName: m.name, role: m.role, siteId,
          checkInAt, checkOutAt,
          checkInMethod: 'FACE', checkOutMethod: 'FACE',
          checkInScore: 0.94, checkOutScore: 0.94,
          status: 'NORMAL', workedMinutes, gongsu,
          dailyWage: m.dailyWage, payAmount: Math.round(m.dailyWage * gongsu),
          geofenceResult: 'INSIDE',
          checkInLocation: geofence ? { lat: geofence.lat, lng: geofence.lng, accuracy: 8, capturedAt: checkInAt } : undefined,
          distanceFromSiteM: 0,
        };
        records[k] = r;
      }
      return r;
    }

    // 1) 얼굴인식 OK 5명 보장 — 부족분만큼 ABSENT 를 출근으로 전환
    let needFaceOk = 5 - buckets.face_ok.length;
    let absentIdx = 0;
    while (needFaceOk > 0 && absentIdx < absentToday.length) {
      const { m } = absentToday[absentIdx++];
      const r = ensureAttended(m);
      r.checkInMethod = 'FACE';
      r.checkOutMethod = 'FACE';
      r.checkInScore = 0.94;
      r.geofenceResult = 'INSIDE';
      r.distanceFromSiteM = 0;
      buckets.face_ok.push(r);
      needFaceOk--;
    }

    // 2) GPS 오류 1~2명 보장 — 이미 5명 face OK 가 있으니 그 중 1~2명을 OUTSIDE 로 변환할 수도 있지만,
    //    UX 상 기존 OK 를 깎으면 카운트가 줄어들므로 별도로 ABSENT → GPS 오류 record 로 추가.
    let needGpsErr = Math.max(0, 1 - buckets.gps_err.length); // 최소 1명 보장 (있으면 추가 X)
    while (needGpsErr > 0 && absentIdx < absentToday.length) {
      const { m } = absentToday[absentIdx++];
      const r = ensureAttended(m);
      r.checkInMethod = 'FACE';
      r.checkOutMethod = 'FACE';
      r.checkInScore = 0.91;
      r.geofenceResult = 'OUTSIDE';
      r.distanceFromSiteM = 320;
      r.checkInLocation = geofence
        ? { lat: geofence.lat + 0.003, lng: geofence.lng + 0.002, accuracy: 12, capturedAt: r.checkInAt! }
        : undefined;
      buckets.gps_err.push(r);
      needGpsErr--;
    }

    // 3) 수동(MANUAL) 1명 보장
    let needManual = Math.max(0, 1 - buckets.manual.length);
    while (needManual > 0 && absentIdx < absentToday.length) {
      const { m } = absentToday[absentIdx++];
      const r = ensureAttended(m);
      r.checkInMethod = 'MANUAL';
      r.checkOutMethod = 'MANUAL';
      r.checkInScore = null;
      r.checkOutScore = null;
      r.geofenceResult = 'NO_LOCATION';
      r.manualReason = '카메라 일시 장애로 반장이 직접 처리';
      buckets.manual.push(r);
      const handler = m.foremanId ? foremenById.get(m.foremanId)?.name : null;
      audit.push({
        id: 'AUD-' + m.id + '-' + todayStr + '-fix',
        type: 'MANUAL_CHECK_IN',
        memberIds: [m.id], memberNames: [m.name],
        reason: r.manualReason!, performedBy: handler ?? '본사 공무', performedAt: r.checkInAt!,
      });
      needManual--;
    }
  }

  return { yearMonth, siteId, records, audit };
}

route('get', /^\/attendance\/month$/, async (req) => {
  const params = req.params ?? {};
  const siteId = (params.siteId as string) ?? '';
  const yearMonth = (params.yearMonth as string) ?? localYearMonth();
  if (!siteId) return { status: 400, data: { message: 'siteId가 필요합니다.' } };
  const bucket = loadAttendanceBucket(siteId, yearMonth);
  const db = loadDb();
  const members = (db.members ?? []).filter((m) => m.siteId === siteId);
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr); const month = Number(mStr);
  const lastDay = new Date(year, month, 0).getDate();
  const dates: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    dates.push(year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
  }
  let totalGongsu = 0, totalPay = 0, faceCount = 0, manualCount = 0;
  let absentCount = 0, lateCount = 0, earlyCount = 0;
  const rows = members.map((m) => {
    const daily: Record<string, AttendanceRecord | undefined> = {};
    let mGongsu = 0, mDays = 0, mPay = 0;
    for (const d of dates) {
      const r = bucket.records[m.id + '|' + d];
      daily[d] = r;
      if (!r) continue;
      if (r.status === 'ABSENT') { absentCount++; continue; }
      mGongsu += r.gongsu; mPay += r.payAmount;
      if (r.gongsu > 0) mDays++;
      if (r.checkInMethod === 'FACE') faceCount++;
      if (r.checkInMethod === 'MANUAL') manualCount++;
      if (r.status === 'LATE') lateCount++;
      if (r.status === 'EARLY') earlyCount++;
    }
    totalGongsu += mGongsu; totalPay += mPay;
    return {
      memberId: m.id, memberName: m.name, role: m.role, dailyWage: m.dailyWage,
      daily, totalGongsu: mGongsu, totalDays: mDays, totalPay: mPay,
    };
  });
  const result: AttendanceMonth = {
    year, month, siteId, dates, rows,
    summary: {
      totalMembers: members.length, totalGongsu, totalPay,
      faceCount, manualCount, absentCount, lateCount, earlyCount,
    },
  };
  return { status: 200, data: result };
});
route('get', /^\/attendance\/today$/, async (req) => {
  const siteId = (req.params?.siteId as string) ?? '';
  if (!siteId) return { status: 400, data: { message: 'siteId가 필요합니다.' } };
  const now = new Date();
  const todayStr = localDateStr(now);
  const yearMonth = todayStr.slice(0, 7);
  const bucket = loadAttendanceBucket(siteId, yearMonth);
  const db = loadDb();
  const members = (db.members ?? []).filter((m) => m.siteId === siteId);

  // ── 자동 일괄 퇴근 (18:00 이후) ──────────────────────────
  // 18:00 넘었고 WORKING 상태(체크인만 있고 체크아웃 없음) 멤버가 있으면
  // 자동으로 18:00 으로 퇴근 처리 + 감사 로그 1줄. 마감된 날은 건드리지 않음.
  if (now.getHours() >= 18 && !isDateClosed(bucket, todayStr)) {
    const autoCheckoutAt = new Date(
      now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0,
    ).toISOString();
    const autoNames: string[] = [];
    const autoIds: string[] = [];
    for (const m of members) {
      const key = m.id + '|' + todayStr;
      const r = bucket.records[key];
      if (r && r.checkInAt && !r.checkOutAt) {
        r.checkOutAt = autoCheckoutAt;
        r.checkOutMethod = 'MANUAL';
        r.checkOutScore = null;
        r.manualReason = (r.manualReason ?? '') + ' [자동 일괄 퇴근(18:00)]';
        const { workedMinutes, gongsu } = calcGongsu(r.checkInAt, r.checkOutAt);
        r.workedMinutes = workedMinutes;
        r.gongsu = gongsu;
        autoIds.push(m.id);
        autoNames.push(m.name);
      }
    }
    if (autoIds.length > 0) {
      bucket.audit.unshift({
        id: 'AUD-AUTO-OUT-' + Date.now().toString(36),
        type: 'BULK_CHECK_OUT',
        memberIds: autoIds,
        memberNames: autoNames,
        reason: `자동 일괄 퇴근 — 18:00 정각 (${autoIds.length}명)`,
        performedBy: '시스템(자동)',
        performedAt: now.toISOString(),
      });
      saveAttendanceBucket(bucket);
    }
  }

  let beforeCount = 0, workingCount = 0, doneCount = 0;
  const memberStatus = members.map((m) => {
    const r = bucket.records[m.id + '|' + todayStr] ?? null;
    let status: 'BEFORE' | 'WORKING' | 'DONE' = 'BEFORE';
    if (r?.checkInAt && r?.checkOutAt) status = 'DONE';
    else if (r?.checkInAt) status = 'WORKING';
    if (status === 'BEFORE') beforeCount++;
    else if (status === 'WORKING') workingCount++;
    else doneCount++;
    return { memberId: m.id, memberName: m.name, role: m.role, status, record: r };
  });
  const res: TodayAttendance = {
    siteId, date: todayStr, members: memberStatus,
    summary: { totalCount: members.length, beforeCount, workingCount, doneCount },
  };
  return { status: 200, data: res };
});
route('post', /^\/attendance\/manual-check$/, async (req) => {
  const body = req.data as ManualCheckRequest;
  if (!body?.memberId || !body?.action || !body?.reason || body.reason.length < 5) {
    return { status: 400, data: { message: '사유는 5자 이상이어야 합니다.' } };
  }
  const db = loadDb();
  const member = (db.members ?? []).find((m) => m.id === body.memberId);
  if (!member) return { status: 404, data: { message: '팀원을 찾을 수 없습니다.' } };
  const todayStr = localDateStr(new Date());
  const yearMonth = todayStr.slice(0, 7);
  const bucket = loadAttendanceBucket(member.siteId, yearMonth);
  if (isDateClosed(bucket, todayStr)) return closedResponse(todayStr);
  const key = member.id + '|' + todayStr;
  const at = body.at ?? new Date().toISOString();
  let r = bucket.records[key];
  if (!r) {
    r = {
      id: 'R-' + member.id + '-' + todayStr, date: todayStr,
      memberId: member.id, memberName: member.name, role: member.role, siteId: member.siteId,
      checkInAt: null, checkOutAt: null,
      checkInMethod: null, checkOutMethod: null,
      checkInScore: null, checkOutScore: null,
      status: 'NORMAL', workedMinutes: 0, gongsu: 0,
      dailyWage: member.dailyWage, payAmount: 0,
    };
  }
  if (body.action === 'CHECK_IN') {
    r.checkInAt = at; r.checkInMethod = 'MANUAL'; r.checkInScore = null;
  } else {
    r.checkOutAt = at; r.checkOutMethod = 'MANUAL'; r.checkOutScore = null;
  }
  r.manualReason = body.reason;
  const { workedMinutes, gongsu } = calcGongsu(r.checkInAt, r.checkOutAt);
  r.workedMinutes = workedMinutes; r.gongsu = gongsu;
  r.payAmount = Math.round(r.dailyWage * gongsu);
  r.status = r.checkInAt && isLate(r.checkInAt) ? 'LATE' : (r.checkOutAt && isEarly(r.checkOutAt) && r.gongsu < 1 ? 'EARLY' : 'NORMAL');
  bucket.records[key] = r;
  bucket.audit.unshift({
    id: 'AUD-' + Date.now().toString(36),
    type: body.action === 'CHECK_IN' ? 'MANUAL_CHECK_IN' : 'MANUAL_CHECK_OUT',
    memberIds: [member.id], memberNames: [member.name],
    reason: body.reason,
    performedBy: currentUserOf(db)?.name ?? '시스템',
    performedAt: at,
  });
  saveAttendanceBucket(bucket);
  const res: ManualCheckResponse = { recordId: r.id, processedAt: at };
  return { status: 200, data: res };
});
route('post', /^\/attendance\/bulk-check-out$/, async (req) => {
  const body = req.data as BulkCheckOutRequest;
  if (!body?.memberIds?.length || !body.reason || body.reason.length < 5) {
    return { status: 400, data: { message: '대상과 5자 이상 사유가 필요합니다.' } };
  }
  const db = loadDb();
  const todayStr = localDateStr(new Date());
  const yearMonth = todayStr.slice(0, 7);
  const at = new Date().toISOString();
  const records: BulkCheckOutResponse['records'] = [];
  const failures: BulkCheckOutResponse['failures'] = [];
  const successNames: string[] = [];
  const successIds: string[] = [];
  for (const memberId of body.memberIds) {
    const member = (db.members ?? []).find((m) => m.id === memberId);
    if (!member) { failures.push({ memberId, reason: '팀원을 찾을 수 없습니다.' }); continue; }
    const bucket = loadAttendanceBucket(member.siteId, yearMonth);
    if (isDateClosed(bucket, todayStr)) {
      failures.push({ memberId, reason: '오늘은 마감되어 변경할 수 없습니다.' });
      continue;
    }
    const key = memberId + '|' + todayStr;
    const r = bucket.records[key];
    if (!r || !r.checkInAt) { failures.push({ memberId, reason: '오늘 출근 기록이 없습니다.' }); continue; }
    if (r.checkOutAt) { failures.push({ memberId, reason: '이미 퇴근 처리됐습니다.' }); continue; }
    r.checkOutAt = at; r.checkOutMethod = 'MANUAL'; r.checkOutScore = null;
    r.manualReason = body.reason;
    const { workedMinutes, gongsu } = calcGongsu(r.checkInAt, r.checkOutAt);
    r.workedMinutes = workedMinutes; r.gongsu = gongsu;
    r.payAmount = Math.round(r.dailyWage * gongsu);
    r.status = isEarly(at) && gongsu < 1 ? 'EARLY' : 'NORMAL';
    bucket.records[key] = r;
    saveAttendanceBucket(bucket);
    records.push({ memberId, recordId: r.id });
    successIds.push(memberId); successNames.push(member.name);
  }
  if (successIds.length > 0) {
    const siteId = (db.members ?? []).find((m) => m.id === successIds[0])?.siteId;
    if (siteId) {
      const bucket = loadAttendanceBucket(siteId, yearMonth);
      bucket.audit.unshift({
        id: 'AUD-BULK-' + Date.now().toString(36),
        type: 'BULK_CHECK_OUT',
        memberIds: successIds, memberNames: successNames,
        reason: body.reason,
        performedBy: currentUserOf(db)?.name ?? '시스템',
        performedAt: at,
      });
      saveAttendanceBucket(bucket);
    }
  }
  const res: BulkCheckOutResponse = { processedAt: at, records, failures };
  return { status: 200, data: res };
});

route('post', /^\/attendance\/bulk-set-gongsu$/, async (req) => {
  const body = req.data as { memberId: string; dates: string[]; gongsu: number; reason: string };
  if (!body?.memberId || !Array.isArray(body?.dates) || body.dates.length === 0 || body.gongsu === undefined) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다. (memberId, dates[], gongsu)' } };
  }
  if (!body.reason || body.reason.trim().length === 0) {
    return { status: 400, data: { message: '사유를 입력해주세요.' } };
  }
  const allowed = [0, 0.5, 1, 1.5, 2];
  if (!allowed.includes(body.gongsu)) {
    return { status: 400, data: { message: '공수는 0/0.5/1.0/1.5/2.0 중 하나여야 합니다.' } };
  }
  const todayStr = localDateStr(new Date());
  const filteredDates = body.dates.filter((d) => d <= todayStr);
  if (filteredDates.length === 0) {
    return { status: 400, data: { message: '미래 일자는 입력할 수 없습니다.' } };
  }
  const db = loadDb();
  const member = (db.members ?? []).find((m) => m.id === body.memberId);
  if (!member) return { status: 404, data: { message: '팀원을 찾을 수 없습니다.' } };

  // 같은 yearMonth 끼리 묶어서 한 번에 처리
  const byMonth = new Map<string, string[]>();
  for (const d of filteredDates) {
    const ym = d.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym)!.push(d);
  }
  let savedCount = 0;
  const datesProcessed: string[] = [];
  for (const [ym, days] of byMonth) {
    const bucket = loadAttendanceBucket(member.siteId, ym);
    for (const date of days) {
      // 마감된 날짜는 스킵 (전체 거절보다는 가능한 만큼만 처리)
      if (isDateClosed(bucket, date)) continue;
      const key = member.id + '|' + date;
      let r = bucket.records[key];
      if (!r) {
        r = {
          id: 'R-' + member.id + '-' + date, date,
          memberId: member.id, memberName: member.name, role: member.role, siteId: member.siteId,
          checkInAt: null, checkOutAt: null,
          checkInMethod: null, checkOutMethod: null,
          checkInScore: null, checkOutScore: null,
          status: 'NORMAL', workedMinutes: 0, gongsu: 0,
          dailyWage: member.dailyWage, payAmount: 0,
        };
      }
      r.gongsu = body.gongsu;
      r.workedMinutes = body.gongsu * 480;
      r.payAmount = Math.round(member.dailyWage * body.gongsu);
      r.manualReason = body.reason;
      if (!r.checkInMethod) r.checkInMethod = 'MANUAL';
      if (!r.checkOutMethod && body.gongsu > 0) r.checkOutMethod = 'MANUAL';
      r.status = body.gongsu === 0 ? 'ABSENT' : 'NORMAL';
      bucket.records[key] = r;
      savedCount++;
      datesProcessed.push(date);
    }
    bucket.audit.unshift({
      id: 'AUD-G-' + Date.now().toString(36) + '-' + ym,
      type: 'MANUAL_GONGSU',
      memberIds: [member.id], memberNames: [member.name],
      reason: `${body.reason} / 공수 ${body.gongsu.toFixed(1)} × ${days.length}일`,
      performedBy: currentUserOf(db)?.name ?? '시스템',
      performedAt: new Date().toISOString(),
    });
    saveAttendanceBucket(bucket);
  }
  return {
    status: 200,
    data: {
      memberId: body.memberId,
      datesProcessed,
      savedCount,
      gongsu: body.gongsu,
    },
  };
});
route('post', /^\/attendance\/set-gongsu$/, async (req) => {
  const body = req.data as { memberId: string; date: string; gongsu: number; reason: string };
  if (!body?.memberId || !body?.date || body.gongsu === undefined) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  }
  if (!body.reason || body.reason.trim().length === 0) {
    return { status: 400, data: { message: '사유를 입력해주세요.' } };
  }
  const allowed = [0, 0.5, 1, 1.5, 2];
  if (!allowed.includes(body.gongsu)) {
    return { status: 400, data: { message: '공수는 0/0.5/1.0/1.5/2.0 중 하나여야 합니다.' } };
  }
  if (body.date > localDateStr(new Date())) {
    return { status: 400, data: { message: '미래 일자는 입력할 수 없습니다.' } };
  }
  const db = loadDb();
  const member = (db.members ?? []).find((m) => m.id === body.memberId);
  if (!member) return { status: 404, data: { message: '팀원을 찾을 수 없습니다.' } };
  const yearMonth = body.date.slice(0, 7);
  const bucket = loadAttendanceBucket(member.siteId, yearMonth);
  if (isDateClosed(bucket, body.date)) return closedResponse(body.date);
  const key = member.id + '|' + body.date;
  let r = bucket.records[key];
  if (!r) {
    r = {
      id: 'R-' + member.id + '-' + body.date, date: body.date,
      memberId: member.id, memberName: member.name, role: member.role, siteId: member.siteId,
      checkInAt: null, checkOutAt: null,
      checkInMethod: null, checkOutMethod: null,
      checkInScore: null, checkOutScore: null,
      status: 'NORMAL', workedMinutes: 0, gongsu: 0,
      dailyWage: member.dailyWage, payAmount: 0,
    };
  }
  // 변경 이력 누적 — 임금 변동 체인 표시용
  const fromGongsu = r.gongsu;
  const fromPay = r.payAmount;
  const toPay = Math.round(member.dailyWage * body.gongsu);
  if (fromGongsu !== body.gongsu) {
    r.manualPayHistory = [
      ...(r.manualPayHistory ?? []),
      {
        at: new Date().toISOString(),
        fromGongsu, fromPay,
        toGongsu: body.gongsu, toPay,
        reason: body.reason,
        by: currentUserOf(db)?.name ?? '시스템',
      },
    ];
  }
  r.gongsu = body.gongsu;
  r.workedMinutes = body.gongsu * 480;
  r.payAmount = toPay;
  r.manualReason = body.reason;
  // 수동 등록 출처 기록 — 현재 로그인한 사용자 역할 기반
  // AdminRole: 'OWNER' | 'MANAGER' | 'STAFF' (FOREMAN 은 모바일 앱에서 별도 식별, admin 백엔드에선 미해당)
  const me = currentUserOf(db);
  if (me) {
    const isHQ = me.assignedSiteId === 'ALL' || me.role === 'OWNER';
    r.manualEntryRole = isHQ ? 'HQ' : 'SITE';
    r.manualEntryByName = me.name;
  }
  // 수동 출역 등록 — checkInAt/checkOutAt 이 비어있으면 기본 출퇴근 시각을 자동 채움
  // 1.0 공수 = 08:00 출근, 17:00 퇴근. 0.5/1.5/2.0 등은 시간 비례하여 보정
  if (!r.checkInMethod) r.checkInMethod = 'MANUAL';
  if (!r.checkOutMethod && body.gongsu > 0) r.checkOutMethod = 'MANUAL';
  if (body.gongsu > 0) {
    const baseDate = new Date(body.date + 'T00:00:00');
    const inMs   = baseDate.getTime() + 8 * 3600 * 1000; // 08:00
    const outMs  = inMs + Math.round(body.gongsu * 9 * 3600 * 1000); // 1공수당 9시간 (식사 1시간 포함)
    if (!r.checkInAt)  r.checkInAt  = new Date(inMs).toISOString();
    if (!r.checkOutAt) r.checkOutAt = new Date(outMs).toISOString();
  }
  r.status = body.gongsu === 0 ? 'ABSENT' : 'NORMAL';
  bucket.records[key] = r;
  bucket.audit.unshift({
    id: 'AUD-G-' + Date.now().toString(36),
    type: 'MANUAL_GONGSU',
    memberIds: [member.id], memberNames: [member.name],
    reason: body.reason + ' / 공수 ' + body.gongsu.toFixed(1),
    performedBy: currentUserOf(db)?.name ?? '시스템',
    performedAt: new Date().toISOString(),
  });
  saveAttendanceBucket(bucket);
  return {
    status: 200,
    data: {
      recordId: r.id,
      date: body.date,
      gongsu: r.gongsu,
      payAmount: r.payAmount,
      processedAt: new Date().toISOString(),
    },
  };
});

// ─── 스마트폰 얼굴인식 출퇴근 (FACE) ───
//
// 향후 모바일 앱에서 호출할 엔드포인트. 현재는 시연용 스텁 — 실 운영 시 서버측에
// 임베딩 매칭·라이브니스 검증·디바이스 차단 등 로직을 추가하면 된다.
//
// 화면(AttendancePage) 은 이미 method='FACE' 와 score 를 표시하도록 돼있어 별도
// UI 변경 없이 동작.

route('post', /^\/attendance\/face-checkin$/, async (req) => {
  const body = req.data as {
    memberId: string;
    siteId: string;
    capturedAt: string;
    matchScore: number;
    liveness: 'PASSED' | 'FAILED' | 'SKIPPED';
    location: { lat: number; lng: number; accuracy: number; capturedAt: string };
    device: { deviceId: string; os: string; model?: string; appVersion: string };
    embedding?: number[];
  };
  if (!body?.memberId || !body?.siteId || !body?.capturedAt) {
    return { status: 400, data: { code: 'BAD_REQUEST', message: '필수 정보가 누락되었습니다.' } };
  }
  const db = loadDb();
  const member = (db.members ?? []).find((m) => m.id === body.memberId);
  if (!member) {
    return { status: 404, data: { code: 'MEMBER_NOT_FOUND', message: '등록된 워커가 없습니다.' } };
  }
  // 1) 라이브니스
  if (body.liveness === 'FAILED') {
    return { status: 422, data: { code: 'LIVENESS_FAILED', message: '얼굴 위변조 의심 — 출근 거부.' } };
  }
  // 2) 매칭 점수 (임계값 0.85)
  if (typeof body.matchScore === 'number' && body.matchScore < 0.85) {
    return { status: 422, data: { code: 'LOW_SCORE', message: `매칭 점수 ${(body.matchScore * 100).toFixed(0)}% — 임계값 85% 미만.` } };
  }
  // 3) 클라 시각 검증 (±30초)
  const now = new Date();
  const capt = new Date(body.capturedAt);
  if (Math.abs(now.getTime() - capt.getTime()) > 30_000) {
    return { status: 422, data: { code: 'STALE_TIMESTAMP', message: '시각 동기화 실패 — 다시 시도해주세요.' } };
  }
  // 4) 지오펜스 검증
  const site = (db.sites ?? []).find((s) => s.id === body.siteId);
  if (site?.geofence && body.location) {
    const dist = haversineMeters(site.geofence, body.location);
    if (dist > site.geofence.radiusM) {
      return {
        status: 422,
        data: {
          code: 'OUT_OF_GEOFENCE',
          message: `현장 반경 밖 — 거리 ${Math.round(dist)}m`,
          detail: { distance: dist, radius: site.geofence.radiusM },
        },
      };
    }
  }
  // 5) 마감일 검증
  const dateStr = body.capturedAt.slice(0, 10);
  const yearMonth = dateStr.slice(0, 7);
  const bucket = loadAttendanceBucket(body.siteId, yearMonth);
  if (isDateClosed(bucket, dateStr)) {
    return { status: 423, data: { code: 'SITE_CLOSED', message: '그 날 출퇴근 마감됨.' } };
  }
  // 6) 기록 생성/갱신
  const key = body.memberId + '|' + dateStr;
  const checkInAt = body.capturedAt;
  let r = bucket.records[key];
  if (!r) {
    r = {
      id: 'R-' + body.memberId + '-' + dateStr, date: dateStr,
      memberId: body.memberId, memberName: member.name, role: member.role, siteId: body.siteId,
      checkInAt, checkOutAt: null,
      checkInMethod: 'FACE', checkOutMethod: null,
      checkInScore: body.matchScore, checkOutScore: null,
      status: 'NORMAL', workedMinutes: 0, gongsu: 0,
      dailyWage: member.dailyWage, payAmount: 0,
      checkInLocation: body.location,
      geofenceResult: 'INSIDE',
      distanceFromSiteM: site?.geofence
        ? Math.round(haversineMeters(site.geofence, body.location))
        : undefined,
    };
  } else {
    r.checkInAt = checkInAt;
    r.checkInMethod = 'FACE';
    r.checkInScore = body.matchScore;
    r.checkInLocation = body.location;
  }
  bucket.records[key] = r;
  bucket.audit.unshift({
    id: 'AUD-FCIN-' + Date.now().toString(36),
    type: 'MANUAL_CHECK_IN',
    memberIds: [body.memberId], memberNames: [member.name],
    reason: `[얼굴인식 출근] ${body.device.model ?? body.device.os} · 점수 ${(body.matchScore * 100).toFixed(0)}%`,
    performedBy: '시스템(FACE)',
    performedAt: now.toISOString(),
  });
  saveAttendanceBucket(bucket);
  return {
    status: 200,
    data: {
      record: r,
      processedAt: now.toISOString(),
      message: `얼굴인식 출근 완료 (인식률 ${(body.matchScore * 100).toFixed(0)}%)`,
    },
  };
});

route('post', /^\/attendance\/face-checkout$/, async (req) => {
  const body = req.data as {
    memberId: string;
    siteId: string;
    capturedAt: string;
    matchScore: number;
    liveness: 'PASSED' | 'FAILED' | 'SKIPPED';
    location: { lat: number; lng: number; accuracy: number; capturedAt: string };
    device: { deviceId: string; os: string; model?: string; appVersion: string };
  };
  if (!body?.memberId || !body?.siteId || !body?.capturedAt) {
    return { status: 400, data: { code: 'BAD_REQUEST', message: '필수 정보가 누락되었습니다.' } };
  }
  const db = loadDb();
  const member = (db.members ?? []).find((m) => m.id === body.memberId);
  if (!member) {
    return { status: 404, data: { code: 'MEMBER_NOT_FOUND', message: '등록된 워커가 없습니다.' } };
  }
  if (body.liveness === 'FAILED') {
    return { status: 422, data: { code: 'LIVENESS_FAILED', message: '얼굴 위변조 의심.' } };
  }
  if (typeof body.matchScore === 'number' && body.matchScore < 0.85) {
    return { status: 422, data: { code: 'LOW_SCORE', message: '매칭 점수 미달.' } };
  }
  const dateStr = body.capturedAt.slice(0, 10);
  const yearMonth = dateStr.slice(0, 7);
  const bucket = loadAttendanceBucket(body.siteId, yearMonth);
  if (isDateClosed(bucket, dateStr)) {
    return { status: 423, data: { code: 'SITE_CLOSED', message: '그 날 출퇴근 마감됨.' } };
  }
  const key = body.memberId + '|' + dateStr;
  const r = bucket.records[key];
  if (!r || !r.checkInAt) {
    return { status: 400, data: { code: 'NO_CHECKIN', message: '출근 기록이 없는 상태에서 퇴근 처리할 수 없습니다.' } };
  }
  r.checkOutAt = body.capturedAt;
  r.checkOutMethod = 'FACE';
  r.checkOutScore = body.matchScore;
  // 공수 재계산
  const { workedMinutes, gongsu } = calcGongsu(r.checkInAt, body.capturedAt);
  r.workedMinutes = workedMinutes;
  r.gongsu = gongsu;
  r.payAmount = Math.round(member.dailyWage * gongsu);
  bucket.records[key] = r;
  bucket.audit.unshift({
    id: 'AUD-FCOUT-' + Date.now().toString(36),
    type: 'MANUAL_CHECK_OUT',
    memberIds: [body.memberId], memberNames: [member.name],
    reason: `[얼굴인식 퇴근] ${body.device.model ?? body.device.os} · 점수 ${(body.matchScore * 100).toFixed(0)}% · 공수 ${gongsu.toFixed(1)}`,
    performedBy: '시스템(FACE)',
    performedAt: new Date().toISOString(),
  });
  saveAttendanceBucket(bucket);
  return {
    status: 200,
    data: {
      record: r,
      processedAt: new Date().toISOString(),
      message: `얼굴인식 퇴근 완료 (공수 ${gongsu.toFixed(1)})`,
    },
  };
});

// ─── 마감 상태 조회 ───
route('get', /^\/attendance\/close-status$/, async (req) => {
  const params = req.params ?? {};
  const siteId = (params.siteId as string) ?? '';
  const yearMonth = (params.yearMonth as string) ?? localYearMonth();
  if (!siteId) return { status: 400, data: { message: 'siteId가 필요합니다.' } };
  const bucket = loadAttendanceBucket(siteId, yearMonth);
  const monthClose: MonthClose = normalizeMonthClose(bucket.monthClose ?? {
    siteId, yearMonth,
    status: 'OPEN', stage: 'OPEN',
    attStage: 'OPEN', wageStage: 'OPEN',
  });
  const dayCloses: DayClose[] = Object.values(bucket.dayCloses ?? {}).filter(
    (dc) => dc.status === 'CLOSED',
  );
  const res: CloseStatusResponse = { siteId, yearMonth, monthClose, dayCloses };
  return { status: 200, data: res };
});

// ─── 일자 마감 / 재개봉 ───
route('post', /^\/attendance\/day-close$/, async (req) => {
  const body = req.data as DayCloseRequest;
  if (!body?.siteId || !body?.date || !body?.action) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  }
  const yearMonth = body.date.slice(0, 7);
  const bucket = loadAttendanceBucket(body.siteId, yearMonth);
  const db = loadDb();
  const me = currentUserOf(db);
  bucket.dayCloses = bucket.dayCloses ?? {};
  const now = new Date().toISOString();
  const myName = me?.name ?? '시스템';
  // 사용자 역할 추정 — assignedSiteId === 'ALL' 이면 HQ
  const isHQUser = !me || me.assignedSiteId === 'ALL';

  // 호환용 액션 라우팅
  let action: DayCloseRequest['action'] = body.action;
  if (action === 'CLOSE') action = isHQUser ? 'CLOSE_BY_HQ' : 'CLOSE_BY_SITE';
  if (action === 'REOPEN') action = isHQUser ? 'REOPEN_BY_HQ' : 'REOPEN_BY_SITE';

  // 월마감 잠금 체크 — 출역 SITE_CLOSED 이상이면 일단위 변경 차단 (단, HQ 액션은 상위에서 결정 — 여기선 attStage HQ_CONFIRMED 만 차단)
  const mc = bucket.monthClose;
  if (mc && (mc.attStage === 'HQ_CONFIRMED' || mc.wageStage === 'PAID' || mc.wageStage === 'SETTLED')) {
    return { status: 423, data: { message: '본사 출역 확정 이후엔 일단위 변경 불가. 본사가 되돌려야 합니다.' } };
  }

  const existing = bucket.dayCloses[body.date] ?? {
    siteId: body.siteId, date: body.date, status: 'OPEN' as const,
  };
  let updated = { ...existing };
  let auditMsg = '';

  if (action === 'CLOSE_BY_SITE') {
    updated.confirmedBySite = { at: now, byName: myName };
    updated.status = 'CLOSED';
    updated.closedAt = now;
    updated.closedByName = myName;
    auditMsg = `${body.date} 현장 오늘 출역 확인`;
  } else if (action === 'CLOSE_BY_HQ') {
    updated.confirmedByHQ = { at: now, byName: myName };
    updated.status = 'CLOSED';
    updated.closedAt = updated.closedAt ?? now;
    updated.closedByName = updated.closedByName ?? myName;
    auditMsg = `${body.date} 본사 오늘 출역 확인`;
  } else if (action === 'REOPEN_BY_SITE') {
    if (!body.reason || body.reason.trim().length < 5) {
      return { status: 400, data: { message: '해제 사유는 5자 이상이어야 합니다.' } };
    }
    updated.confirmedBySite = undefined;
    if (!updated.confirmedByHQ) updated.status = 'OPEN';
    updated.reopenedAt = now;
    updated.reopenedByName = myName;
    updated.reopenReason = body.reason;
    auditMsg = `${body.date} 현장 오늘 출역 확인 해제 — ${body.reason}`;
  } else if (action === 'REOPEN_BY_HQ') {
    if (!body.reason || body.reason.trim().length < 5) {
      return { status: 400, data: { message: '해제 사유는 5자 이상이어야 합니다.' } };
    }
    updated.confirmedByHQ = undefined;
    if (!updated.confirmedBySite) updated.status = 'OPEN';
    updated.reopenedAt = now;
    updated.reopenedByName = myName;
    updated.reopenReason = body.reason;
    auditMsg = `${body.date} 본사 오늘 출역 확인 해제 — ${body.reason}`;
  } else {
    return { status: 400, data: { message: '알 수 없는 action 입니다.' } };
  }

  bucket.dayCloses[body.date] = updated;
  // 감사 로그에도 흔적
  bucket.audit.unshift({
    id: 'AUD-DAYCLOSE-' + Date.now().toString(36),
    type: 'MANUAL_GONGSU',
    memberIds: [], memberNames: [],
    reason: auditMsg,
    performedBy: myName,
    performedAt: now,
  });
  saveAttendanceBucket(bucket);
  return { status: 200, data: { ok: true } };
});

// ─── 월 마감 워크플로우 — 8단계 상태기계 (출역 × 노임 × 지급/정산 분리) ───
//
//   출역 attStage: OPEN ──ATT_SITE_CLOSE──▶ SITE_CLOSED ──ATT_HQ_CONFIRM──▶ HQ_CONFIRMED
//                                              ◀ATT_REOPEN◀                    ◀ATT_REVERT_CONFIRM◀
//
//   노임 wageStage (출역=HQ_CONFIRMED 일 때만): OPEN ──WAGE_SITE_CLOSE──▶ SITE_CLOSED
//                                                         ──WAGE_HQ_CONFIRM──▶ HQ_CONFIRMED
//                                                         ──PAY──▶ PAID ──SETTLE──▶ SETTLED ●
//

/** MonthClose 정규화 — 신규 필드 보장 + 호환용 stage·status 파생 */
function normalizeMonthClose(mc: MonthClose): MonthClose {
  // 신규 필드 마이그레이션 — 구 stage 에서 attStage / wageStage 추론
  if (!mc.attStage || !mc.wageStage) {
    const oldStage = mc.stage ?? (mc.status === 'CLOSED' ? 'SITE_CLOSED' : 'OPEN');
    if (!mc.attStage) {
      mc.attStage =
        oldStage === 'OPEN' ? 'OPEN' :
        oldStage === 'SITE_CLOSED' ? 'SITE_CLOSED' :
        'HQ_CONFIRMED'; // HQ_CONFIRMED 이상이면 출역은 HQ_CONFIRMED 까지 진행됨
      // 구 closedAt → attSiteClosedAt 마이그레이션
      if (mc.attStage !== 'OPEN' && !mc.attSiteClosedAt && mc.closedAt) {
        mc.attSiteClosedAt = mc.closedAt;
        mc.attSiteClosedByName = mc.closedByName;
      }
      if (mc.attStage === 'HQ_CONFIRMED' && !mc.attHqConfirmedAt && mc.hqConfirmedAt) {
        mc.attHqConfirmedAt = mc.hqConfirmedAt;
        mc.attHqConfirmedByName = mc.hqConfirmedByName;
      }
    }
    if (!mc.wageStage) {
      mc.wageStage =
        oldStage === 'SETTLED' ? 'SETTLED' :
        'OPEN'; // 그 외엔 노임 미진행으로 간주
      if (mc.wageStage === 'SETTLED' && mc.settledAt) {
        // 호환 — settledAt 만 있던 경우
      }
    }
  }
  // 호환 필드 파생
  mc.stage = deriveStage(mc.attStage, mc.wageStage);
  mc.status = (mc.attStage !== 'OPEN' || mc.wageStage !== 'OPEN') ? 'CLOSED' : 'OPEN';
  return mc;
}

function deriveStage(att: AttCloseStage, wage: WageCloseStage): CloseStage {
  if (wage === 'SETTLED') return 'SETTLED';
  if (wage === 'PAID') return 'PAID';
  if (wage === 'HQ_CONFIRMED') return 'HQ_CONFIRMED';
  if (att === 'HQ_CONFIRMED') return 'HQ_CONFIRMED';
  if (att === 'SITE_CLOSED') return 'SITE_CLOSED';
  return 'OPEN';
}

route('post', /^\/attendance\/month-close$/, async (req) => {
  const body = req.data as MonthCloseRequest;
  if (!body?.siteId || !body?.yearMonth || !body?.action) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  }
  const bucket = loadAttendanceBucket(body.siteId, body.yearMonth);
  const db = loadDb();
  const me = currentUserOf(db);
  const now = new Date().toISOString();
  const myName = me?.name ?? '시스템';

  // 현재 상태 + 정규화
  const cur: MonthClose = normalizeMonthClose(bucket.monthClose ?? {
    siteId: body.siteId, yearMonth: body.yearMonth,
    status: 'OPEN', stage: 'OPEN',
    attStage: 'OPEN', wageStage: 'OPEN',
  });

  // SETTLED 는 종단 — UNSETTLE 만 허용
  if (cur.wageStage === 'SETTLED' && body.action !== 'UNSETTLE') {
    return { status: 423, data: { message: '정산 완료된 월은 변경할 수 없습니다. (UNSETTLE 만 가능)' } };
  }

  // 호환용 액션 라우팅
  let action = body.action;
  if (action === 'CLOSE')          action = 'ATT_SITE_CLOSE';
  if (action === 'REOPEN')         action = 'ATT_REOPEN';
  if (action === 'CONFIRM')        action = 'ATT_HQ_CONFIRM';
  if (action === 'REVERT_CONFIRM') action = 'ATT_REVERT_CONFIRM';

  let next: MonthClose = { ...cur };
  let auditMsg = '';
  const requireReason = (label: string) => {
    if (!body.reason || body.reason.trim().length < 5) {
      throw { status: 400, data: { message: `${label} 사유는 5자 이상이어야 합니다.` } };
    }
  };

  try {
    switch (action) {
      // ───── 출역 ─────
      case 'ATT_SITE_CLOSE': {
        if (cur.attStage !== 'OPEN') {
          return { status: 409, data: { message: '이미 출역이 마감된 월입니다.' } };
        }
        next.attStage = 'SITE_CLOSED';
        next.attSiteClosedAt = now;
        next.attSiteClosedByName = myName;
        auditMsg = `${body.yearMonth} ③ 현장 월 공수 확정`;
        break;
      }
      case 'ATT_REOPEN': {
        if (cur.attStage !== 'SITE_CLOSED') {
          return { status: 423, data: { message: '본사 출역 확정 후엔 현장에서 해지할 수 없습니다. 본사에 요청하세요.' } };
        }
        if (cur.wageStage !== 'OPEN') {
          return { status: 423, data: { message: '노임 단계가 진행 중인 월은 출역을 되돌릴 수 없습니다.' } };
        }
        requireReason('출역 해지');
        next.attStage = 'OPEN';
        next.attSiteClosedAt = undefined;
        next.attSiteClosedByName = undefined;
        next.attReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 현장 월 공수 확정 해지 — ${body.reason}`;
        break;
      }
      case 'ATT_HQ_CONFIRM': {
        if (cur.attStage !== 'SITE_CLOSED') {
          return { status: 409, data: { message: '현장 출역 확정 이후에만 본사 확인이 가능합니다.' } };
        }
        next.attStage = 'HQ_CONFIRMED';
        next.attHqConfirmedAt = now;
        next.attHqConfirmedByName = myName;
        auditMsg = `${body.yearMonth} ④ 본사 월 공수 확정`;
        break;
      }
      case 'ATT_REVERT_CONFIRM': {
        if (cur.attStage !== 'HQ_CONFIRMED') {
          return { status: 409, data: { message: '본사 출역 확정된 월만 되돌릴 수 있습니다.' } };
        }
        if (cur.wageStage !== 'OPEN') {
          return { status: 423, data: { message: '노임 단계가 진행 중인 월은 출역을 되돌릴 수 없습니다.' } };
        }
        requireReason('출역 되돌림');
        next.attStage = 'SITE_CLOSED';
        next.attHqConfirmedAt = undefined;
        next.attHqConfirmedByName = undefined;
        next.attReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 본사 월 공수 확정 되돌림 — ${body.reason}`;
        break;
      }

      // ───── 노임 (출역=HQ_CONFIRMED 일 때만) ─────
      case 'WAGE_SITE_CLOSE': {
        if (cur.attStage !== 'HQ_CONFIRMED') {
          return { status: 409, data: { message: '본사 출역 확정 이후에만 노임 마감이 가능합니다.' } };
        }
        if (cur.wageStage !== 'OPEN') {
          return { status: 409, data: { message: '이미 노임 마감이 진행된 월입니다.' } };
        }
        next.wageStage = 'SITE_CLOSED';
        next.wageSiteClosedAt = now;
        next.wageSiteClosedByName = myName;
        auditMsg = `${body.yearMonth} ⑤ 현장 월 노임 확정`;
        break;
      }
      case 'WAGE_REOPEN': {
        if (cur.wageStage !== 'SITE_CLOSED') {
          return { status: 423, data: { message: '본사 노임 확정 후엔 현장에서 해지할 수 없습니다.' } };
        }
        requireReason('노임 해지');
        next.wageStage = 'OPEN';
        next.wageSiteClosedAt = undefined;
        next.wageSiteClosedByName = undefined;
        next.wageReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 현장 월 노임 확정 해지 — ${body.reason}`;
        break;
      }
      case 'WAGE_HQ_CONFIRM': {
        if (cur.wageStage !== 'SITE_CLOSED') {
          return { status: 409, data: { message: '현장 노임 확정 이후에만 본사 확인이 가능합니다.' } };
        }
        next.wageStage = 'HQ_CONFIRMED';
        next.wageHqConfirmedAt = now;
        next.wageHqConfirmedByName = myName;
        auditMsg = `${body.yearMonth} ⑥ 본사 월 노임 확정`;
        break;
      }
      case 'WAGE_REVERT_CONFIRM': {
        if (cur.wageStage !== 'HQ_CONFIRMED') {
          return { status: 409, data: { message: '본사 노임 확정된 월만 되돌릴 수 있습니다.' } };
        }
        requireReason('노임 되돌림');
        next.wageStage = 'SITE_CLOSED';
        next.wageHqConfirmedAt = undefined;
        next.wageHqConfirmedByName = undefined;
        next.wageReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 본사 월 노임 확정 되돌림 — ${body.reason}`;
        break;
      }

      // ───── 지급 / 정산 ─────
      case 'PAY': {
        if (cur.wageStage !== 'HQ_CONFIRMED') {
          return { status: 409, data: { message: '본사 노임 확정 이후에만 지급 처리할 수 있습니다.' } };
        }
        next.wageStage = 'PAID';
        next.paidAt = now;
        next.paidByName = myName;
        auditMsg = `${body.yearMonth} ⑦ 본사 노임 지급`;
        break;
      }
      case 'UNPAY': {
        if (cur.wageStage !== 'PAID') {
          return { status: 409, data: { message: '지급된 월만 되돌릴 수 있습니다.' } };
        }
        requireReason('지급 되돌림');
        next.wageStage = 'HQ_CONFIRMED';
        next.paidAt = undefined;
        next.paidByName = undefined;
        next.wageReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 본사 노임 지급 되돌림 — ${body.reason}`;
        break;
      }
      case 'ISSUE_PAYSLIPS': {
        if (cur.wageStage !== 'PAID') {
          return { status: 409, data: { message: '지급 완료 이후에만 명세서 발행이 가능합니다.' } };
        }
        if (cur.payslipsIssuedAt) {
          return { status: 409, data: { message: '이미 명세서가 발행된 월입니다.' } };
        }
        next.payslipsIssuedAt = now;
        next.payslipsIssuedByName = myName;
        auditMsg = `${body.yearMonth} 마. 명세서 발행`;
        break;
      }
      case 'UNDO_PAYSLIPS': {
        if (!cur.payslipsIssuedAt) {
          return { status: 409, data: { message: '명세서 발행 기록이 없습니다.' } };
        }
        requireReason('명세서 발행 되돌림');
        next.payslipsIssuedAt = undefined;
        next.payslipsIssuedByName = undefined;
        next.wageReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 명세서 발행 되돌림 — ${body.reason}`;
        break;
      }
      case 'SETTLE': {
        if (cur.wageStage !== 'PAID') {
          return { status: 409, data: { message: '노임 지급 이후에만 정산 완료할 수 있습니다.' } };
        }
        if (!cur.payslipsIssuedAt) {
          return { status: 409, data: { message: '명세서 발행 후에만 마감 처리할 수 있습니다.' } };
        }
        next.wageStage = 'SETTLED';
        next.settledAt = now;
        next.settledByName = myName;
        auditMsg = `${body.yearMonth} 바. 마감 (정산 완료)`;
        break;
      }
      case 'UNSETTLE': {
        if (cur.wageStage !== 'SETTLED') {
          return { status: 409, data: { message: '정산 완료된 월만 되돌릴 수 있습니다.' } };
        }
        requireReason('정산 되돌림');
        next.wageStage = 'PAID';
        next.settledAt = undefined;
        next.settledByName = undefined;
        next.wageReopenReason = body.reason;
        auditMsg = `${body.yearMonth} 정산 완료 되돌림 — ${body.reason}`;
        break;
      }

      default:
        return { status: 400, data: { message: '알 수 없는 action 입니다.' } };
    }
  } catch (errResp: any) {
    if (errResp?.status && errResp?.data) return errResp;
    throw errResp;
  }

  // 호환 필드 파생
  next = normalizeMonthClose(next);
  bucket.monthClose = next;
  bucket.audit.unshift({
    id: 'AUD-MONTHCLOSE-' + Date.now().toString(36),
    type: 'MANUAL_GONGSU',
    memberIds: [], memberNames: [],
    reason: auditMsg,
    performedBy: myName,
    performedAt: now,
  });
  saveAttendanceBucket(bucket);
  return { status: 200, data: { ok: true } };
});

// ─── 하도급 출력인원 확인 ───
//   sub 회사 사용자가 자기 회사(SiteCompany) 의 출력인원 확인 → MonthClose.subVerifications 추가
//   원도급 화면에선 그 칩이 자동 노출됨
route('post', /^\/attendance\/month-sub-verify$/, async (req) => {
  const body = req.data as { siteId: string; yearMonth: string; siteCompanyId: string };
  if (!body?.siteId || !body?.yearMonth || !body?.siteCompanyId) {
    return { status: 400, data: { message: '필수 정보가 누락되었습니다.' } };
  }
  const bucket = loadAttendanceBucket(body.siteId, body.yearMonth);
  const db = loadDb();
  const me = currentUserOf(db);
  const sc = db.siteCompanies.find((x) => x.id === body.siteCompanyId);
  const co = sc ? db.companies.find((c) => c.id === sc.companyId) : null;
  const now = new Date().toISOString();
  const myName = me?.name ?? '시스템';
  const cur: MonthClose = normalizeMonthClose(bucket.monthClose ?? {
    siteId: body.siteId, yearMonth: body.yearMonth,
    status: 'OPEN', stage: 'OPEN',
    attStage: 'OPEN', wageStage: 'OPEN',
  });
  const subs = cur.subVerifications ?? [];
  // 같은 siteCompanyId 가 있으면 갱신, 없으면 추가
  const idx = subs.findIndex((v) => v.siteCompanyId === body.siteCompanyId);
  const entry = {
    siteCompanyId: body.siteCompanyId,
    companyName: co?.name ?? '하도급사',
    verifiedAt: now,
    verifiedByName: myName,
  };
  if (idx >= 0) subs[idx] = entry;
  else subs.push(entry);
  bucket.monthClose = { ...cur, subVerifications: subs };
  bucket.audit.unshift({
    id: 'AUD-SUBVERIFY-' + Date.now().toString(36),
    type: 'MANUAL_GONGSU',
    memberIds: [], memberNames: [],
    reason: `${body.yearMonth} 하도급 출력인원 확인 — ${entry.companyName}`,
    performedBy: myName,
    performedAt: now,
  });
  saveAttendanceBucket(bucket);
  return { status: 200, data: { ok: true } };
});

route('get', /^\/attendance\/audit-log$/, async (req) => {
  const params = req.params ?? {};
  const siteId = (params.siteId as string) ?? '';
  const yearMonth = (params.yearMonth as string) ?? localYearMonth();
  const limit = Number(params.limit ?? 50);
  if (!siteId) return { status: 400, data: { message: 'siteId가 필요합니다.' } };
  const db = loadDb();
  const bucket = loadAttendanceBucket(siteId, yearMonth);
  // 회사 단위 가시성 — bcheol(B철근 본사) 가 인천 audit 보면 B철근 작업자 audit 만 노출.
  // 단, 그 site 의 owner 회사 사용자는 모든 회사 audit 가시.
  const me = currentUserOf(db);
  const sitesById = new Map((db.sites ?? []).map((s) => [s.id, s] as const));
  const isOwner = sitesById.get(siteId)?.ownerCompanyId === me?.companyId;
  const myMemberIds = new Set(
    (db.members ?? [])
      .filter((m) => {
        if (m.siteId !== siteId) return false;
        if (!me) return false;
        if (isOwner) return true;
        // 자기 회사 SiteCompany 에 속한 작업자만
        const sc = (db.siteCompanies ?? []).find(
          (x) => x.siteId === siteId && x.companyId === me.companyId && x.status === 'ACTIVE',
        );
        return sc && m.siteCompanyId === sc.id;
      })
      .map((m) => m.id),
  );
  const filtered = bucket.audit.filter((a) => {
    // memberIds 가 모두 myMemberIds 안에 있어야 노출 (혼합 항목은 일단 제외)
    if (!a.memberIds || a.memberIds.length === 0) return true; // 비특정 audit 은 통과
    return a.memberIds.every((id) => myMemberIds.has(id));
  });
  const entries = filtered.slice(0, limit);
  return { status: 200, data: { entries } };
});

// ─────────────────────────────────────────────────────────
//                 안전관리 (Safety) 라우트
// ─────────────────────────────────────────────────────────

route('get', /^\/safety\/categories$/, async () => {
  const db = loadDb();
  const cats = (db.safetyCategories ?? []).slice().sort((a: any, b: any) => a.sortOrder - b.sortOrder);
  return { status: 200, data: { categories: cats } };
});

route('post', /^\/safety\/categories$/, async (req) => {
  const db = loadDb();
  const me = currentUserOf(db);
  const body = req.data as { icon: string; title: string; defaultMsg: string; severity: string };
  const newCat = {
    id: 'SCAT-USR-' + Date.now().toString().slice(-6),
    icon: body.icon || '🦺',
    title: body.title,
    defaultMsg: body.defaultMsg,
    severity: (body.severity ?? 'NORMAL') as 'NORMAL' | 'CAUTION' | 'CRITICAL',
    isStandard: false,
    sortOrder: ((db.safetyCategories ?? []).length) + 1,
    createdAt: new Date().toISOString(),
    createdBy: me ? { userId: me.userId, name: me.name } : undefined,
  appliedRoles: (body as any).appliedRoles ?? [],
  };
  db.safetyCategories = [...(db.safetyCategories ?? []), newCat];
  // 감사 로그
  const audit = {
    id: 'SADT-' + Date.now().toString().slice(-6),
    type: 'CREATE_CATEGORY',
    performedBy: me ? { userId: me.userId, name: me.name } : { userId: 'system', name: '시스템' },
    performedAt: new Date().toISOString(),
    targetId: newCat.id,
    summary: `카테고리 추가 — ${newCat.title}`,
  };
  db.safetyAudit = [audit, ...(db.safetyAudit ?? [])];
  saveDb(db);
  return { status: 201, data: { category: newCat } };
});

route('put', /^\/safety\/categories\/([^/]+)$/, async (req) => {
  const db = loadDb();
  const me = currentUserOf(db);
  const m = (req.url ?? '').match(/^\/safety\/categories\/([^/]+)$/);
  const id = m?.[1] ?? '';
  const idx = (db.safetyCategories ?? []).findIndex((c: any) => c.id === id);
  if (idx === -1) return { status: 404, data: { message: '카테고리를 찾을 수 없습니다.' } };
  const target = db.safetyCategories[idx];
  if (target.isStandard) return { status: 403, data: { message: '표준 카테고리는 수정할 수 없습니다.' } };
  const body = req.data as { icon?: string; title?: string; defaultMsg?: string; severity?: string };
  const next = {
    ...target,
    icon: body.icon ?? target.icon,
    title: body.title ?? target.title,
    defaultMsg: body.defaultMsg ?? target.defaultMsg,
    severity: (body.severity ?? target.severity) as 'NORMAL' | 'CAUTION' | 'CRITICAL',
  appliedRoles: ((body as any).appliedRoles ?? target.appliedRoles ?? []) as string[],
  };
  db.safetyCategories[idx] = next;
  const audit = {
    id: 'SADT-' + Date.now().toString().slice(-6),
    type: 'UPDATE_CATEGORY',
    performedBy: me ? { userId: me.userId, name: me.name } : { userId: 'system', name: '시스템' },
    performedAt: new Date().toISOString(),
    targetId: next.id,
    summary: `카테고리 수정 — ${next.title}`,
    payload: { before: target, after: next },
  };
  db.safetyAudit = [audit, ...(db.safetyAudit ?? [])];
  saveDb(db);
  return { status: 200, data: { category: next } };
});

route('delete', /^\/safety\/categories\/([^/]+)$/, async (req) => {
  const db = loadDb();
  const me = currentUserOf(db);
  const m = (req.url ?? '').match(/^\/safety\/categories\/([^/]+)$/);
  const id = m?.[1] ?? '';
  const target = (db.safetyCategories ?? []).find((c: any) => c.id === id);
  if (!target) return { status: 404, data: { message: '카테고리를 찾을 수 없습니다.' } };
  if (target.isStandard) return { status: 403, data: { message: '표준 카테고리는 삭제할 수 없습니다.' } };
  db.safetyCategories = (db.safetyCategories ?? []).filter((c: any) => c.id !== id);
  const audit = {
    id: 'SADT-' + Date.now().toString().slice(-6),
    type: 'DELETE_CATEGORY',
    performedBy: me ? { userId: me.userId, name: me.name } : { userId: 'system', name: '시스템' },
    performedAt: new Date().toISOString(),
    targetId: id,
    summary: `카테고리 삭제 — ${target.title}`,
  };
  db.safetyAudit = [audit, ...(db.safetyAudit ?? [])];
  saveDb(db);
  return { status: 200, data: { ok: true } };
});

route('get', /^\/safety\/messages$/, async (req) => {
  const db = loadDb();
  const { fromDate, toDate, siteId, categoryId, q } = (req.params ?? {}) as Record<string, string>;
  let list = (db.safetyMessages ?? []).slice();
  if (fromDate) list = list.filter((m: any) => m.sentAt.slice(0, 10) >= fromDate);
  if (toDate) list = list.filter((m: any) => m.sentAt.slice(0, 10) <= toDate);
  if (siteId) list = list.filter((m: any) => (m.recipients ?? []).some((r: any) => r.siteId === siteId));
  if (categoryId) list = list.filter((m: any) => m.categoryId === categoryId);
  if (q) {
    const qq = q.toLowerCase();
    list = list.filter(
      (m: any) =>
        (m.message ?? '').toLowerCase().includes(qq) ||
        (m.categoryTitle ?? '').toLowerCase().includes(qq) ||
        (m.recipients ?? []).some((r: any) => (r.name ?? '').toLowerCase().includes(qq)),
    );
  }
  return { status: 200, data: { messages: list, total: list.length } };
});

route('post', /^\/safety\/messages$/, async (req) => {
  const db = loadDb();
  const me = currentUserOf(db);
  const body = req.data as {
    categoryId: string | null; categoryTitle: string; message: string; severity: string;
    recipients?: Array<any>;
    audienceFilter: 'ALL_REGISTERED' | 'WORKING_TODAY' | 'BY_FOREMAN' | 'BY_ROLE' | 'CUSTOM';
    audienceArg?: string;
    siteId?: string;
    channels: Array<'SMS' | 'APP'>;
    note?: string;
  };
  if (!body.message?.trim()) return { status: 400, data: { message: '메시지 본문이 비어 있습니다.' } };
  if (!body.channels || body.channels.length === 0) return { status: 400, data: { message: '발송 채널을 선택하세요.' } };

  // ─── audienceFilter 에 따라 수신자 자동 추출 ───
  let recipients = body.recipients ?? [];
  if ((!recipients || recipients.length === 0) && body.audienceFilter !== 'CUSTOM') {
    const targetSites = body.siteId && body.siteId !== 'ALL'
      ? db.sites.filter((s: any) => s.id === body.siteId)
      : db.sites.filter((s: any) => s.status !== 'COMPLETED');
    const targetSiteIds = new Set(targetSites.map((s: any) => s.id));

    if (body.audienceFilter === 'WORKING_TODAY') {
      // 오늘 출근한 팀원만 — 출퇴근 데이터 사용
      const today = localDateStr(new Date());
      const allMembers = db.members.filter((m: any) => targetSiteIds.has(m.siteId));
      // mock — 시연용으로 약 70% 출근으로 가정 (실제 데이터 부재 fallback)
      const workingIds = new Set(
        allMembers.filter((_: any, i: number) => i % 10 < 7).map((m: any) => m.id),
      );
      recipients = allMembers
        .filter((m: any) => workingIds.has(m.id))
        .map((m: any) => {
          const site = db.sites.find((s: any) => s.id === m.siteId);
          return {
            kind: 'WORKER',
            id: m.id,
            name: m.name,
            phone: m.phone,
            siteId: m.siteId,
            siteName: site?.name,
          };
        });
    } else if (body.audienceFilter === 'BY_FOREMAN' && body.audienceArg) {
      // 특정 반장이 관리하는 팀원
      const foremanId = body.audienceArg;
      const teamMembers = db.members.filter((m: any) => m.foremanId === foremanId);
      recipients = teamMembers.map((m: any) => {
        const site = db.sites.find((s: any) => s.id === m.siteId);
        return {
          kind: 'WORKER',
          id: m.id,
          name: m.name,
          phone: m.phone,
          siteId: m.siteId,
          siteName: site?.name,
        };
      });
    } else if (body.audienceFilter === 'BY_ROLE' && body.audienceArg) {
      // 특정 직종(부분 문자열 매칭)
      const roleKey = body.audienceArg;
      const matched = db.members.filter(
        (m: any) => targetSiteIds.has(m.siteId) && (m.role ?? '').includes(roleKey),
      );
      recipients = matched.map((m: any) => {
        const site = db.sites.find((s: any) => s.id === m.siteId);
        return { kind: 'WORKER', id: m.id, name: m.name, phone: m.phone, siteId: m.siteId, siteName: site?.name };
      });
    } else {
      // ALL_REGISTERED
      const allMembers = db.members.filter((m: any) => targetSiteIds.has(m.siteId));
      recipients = allMembers.map((m: any) => {
        const site = db.sites.find((s: any) => s.id === m.siteId);
        return { kind: 'WORKER', id: m.id, name: m.name, phone: m.phone, siteId: m.siteId, siteName: site?.name };
      });
    }
  }

  const sentAt = new Date().toISOString();
  const id = 'SMSG-' + Date.now().toString().slice(-6);
  const newMsg = {
    id,
    categoryId: body.categoryId,
    categoryTitle: body.categoryTitle,
    message: body.message,
    severity: (body.severity ?? 'NORMAL') as 'NORMAL' | 'CAUTION' | 'CRITICAL',
    recipients,
    channels: body.channels,
    audienceFilter: body.audienceFilter,
    sentBy: me ? { userId: me.userId, name: me.name } : { userId: 'system', name: '시스템' },
    sentAt,
    status: (recipients.length === 0 ? 'FAILED' : 'SENT') as 'SENT' | 'PARTIAL' | 'FAILED',
    note: body.note,
    readReceipts: recipients.map((r: any) => ({ recipientId: r.id, recipientName: r.name })),
    deliveryAttempts: [{
      attempt: 1,
      at: sentAt,
      unreadCount: recipients.length,
      targetCount: recipients.length,
      triggeredBy: (me ? { userId: me.userId, name: me.name } : 'system') as { userId: string; name: string } | 'system',
    }],
  };
  db.safetyMessages = [newMsg, ...(db.safetyMessages ?? [])];
  const audit = {
    id: 'SADT-' + Date.now().toString().slice(-6),
    type: 'SEND_MESSAGE',
    performedBy: newMsg.sentBy,
    performedAt: newMsg.sentAt,
    targetId: id,
    summary: `${newMsg.categoryTitle} 발송 — ${recipients.length}명 (${body.audienceFilter}, ${body.channels.join(', ')})`,
    payload: { recipientCount: recipients.length, channels: body.channels, audienceFilter: body.audienceFilter },
  };
  db.safetyAudit = [audit, ...(db.safetyAudit ?? [])];
  saveDb(db);
  return { status: 201, data: { message: newMsg, audit } };
});

// 미확인자 재발송
route('post', /^\/safety\/messages\/([^/]+)\/resend$/, async (req) => {
  const db = loadDb();
  const me = currentUserOf(db);
  const m = (req.url ?? '').match(/^\/safety\/messages\/([^/]+)\/resend$/);
  const id = m?.[1] ?? '';
  const body = (req.data ?? {}) as { channels?: Array<'SMS' | 'APP'> };
  const idx = (db.safetyMessages ?? []).findIndex((x: any) => x.id === id);
  if (idx === -1) return { status: 404, data: { message: '메시지를 찾을 수 없습니다.' } };
  const target = db.safetyMessages[idx];
  if ((target.deliveryAttempts ?? []).length >= 4) {
    return { status: 400, data: { message: '재발송은 최대 3회까지 가능합니다.' } };
  }
  const unread = (target.readReceipts ?? []).filter((r: any) => !r.readAt);
  if (unread.length === 0) {
    return { status: 400, data: { message: '미확인자가 없습니다.' } };
  }
  const at = new Date().toISOString();
  target.deliveryAttempts = [
    ...(target.deliveryAttempts ?? []),
    {
      attempt: (target.deliveryAttempts?.length ?? 0) + 1,
      at,
      unreadCount: unread.length,
      targetCount: target.recipients.length,
      triggeredBy: (me ? { userId: me.userId, name: me.name } : 'system') as { userId: string; name: string } | 'system',
    },
  ];
  let readNow = 0;
  target.readReceipts = (target.readReceipts ?? []).map((r: any, i: number) => {
    if (r.readAt) return r;
    if (i % 2 === 0) {
      readNow++;
      return { ...r, readAt: at, via: 'REPLY' as const };
    }
    return r;
  });
  const remainingUnread = (target.readReceipts ?? []).filter((r: any) => !r.readAt).length;
  target.status = remainingUnread === 0 ? 'SENT' : 'PARTIAL';
  if (body.channels && body.channels.length > 0) {
    target.channels = Array.from(new Set([...target.channels, ...body.channels]));
  }
  db.safetyMessages[idx] = target;
  const audit = {
    id: 'SADT-' + Date.now().toString().slice(-6),
    type: 'RESEND_UNREAD',
    performedBy: me ? { userId: me.userId, name: me.name } : { userId: 'system', name: '시스템' },
    performedAt: at,
    targetId: id,
    summary: `미확인자 재발송 — ${unread.length}명 → ${remainingUnread}명 잔여 (${target.categoryTitle})`,
    payload: { resentCount: unread.length, readNowCount: readNow },
  };
  db.safetyAudit = [audit, ...(db.safetyAudit ?? [])];
  saveDb(db);
  return { status: 200, data: { message: target, audit, resentCount: unread.length } };
});

// 오늘 추천 (공종 기반)
route('get', /^\/safety\/recommendations$/, async () => {
  const db = loadDb();
  const sites = (db.sites ?? []).filter((s: any) => s.status !== 'COMPLETED');
  const siteIds = new Set(sites.map((s: any) => s.id));
  const allMembers = (db.members ?? []).filter((m: any) => siteIds.has(m.siteId));
  const workingMembers = allMembers.filter((_: any, i: number) => i % 10 < 7);
  const rolesMap = new Map<string, number>();
  for (const m of workingMembers) {
    const r = m.role ?? '기타';
    rolesMap.set(r, (rolesMap.get(r) ?? 0) + 1);
  }
  const rolesDistribution = Array.from(rolesMap.entries())
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count);
  const cats = (db.safetyCategories ?? []) as any[];
  const recommendations = cats
    .map((cat) => {
      const applied: string[] = cat.appliedRoles ?? [];
      if (applied.length === 0) return null;
      let matchedWorkers = 0;
      const matchedRoles = new Set<string>();
      for (const m of workingMembers) {
        const role = (m.role ?? '');
        for (const a of applied) {
          if (role.includes(a)) {
            matchedWorkers++;
            matchedRoles.add(role);
            break;
          }
        }
      }
      if (matchedWorkers === 0) return null;
      return { category: cat, matchedWorkers, matchedRoles: Array.from(matchedRoles).slice(0, 4) };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.matchedWorkers - a.matchedWorkers)
    .slice(0, 4);
  const monthNum = new Date().getMonth() + 1;
  const weather = monthNum >= 6 && monthNum <= 8
    ? { condition: 'HEAT' as const, label: '폭염주의보' }
    : monthNum === 12 || monthNum <= 2
      ? { condition: 'COLD' as const, label: '한파주의보' }
      : { condition: 'NORMAL' as const, label: '평이' };
  return { status: 200, data: { workingToday: workingMembers.length, rolesDistribution, recommendations, weather } };
});

export function setupMockBackend(client?: AxiosInstance) {
  if (typeof window === 'undefined') return;
  if (!client) return;
  client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    await wait();
    const method = (config.method ?? 'get').toLowerCase() as Method;
    const url = (config.url ?? '').replace(/^\/api/, '') || '/';
    const matched = handlers.find((r) => r.method === method && r.pattern.test(url));
    if (!matched) {
      return Promise.reject({
        response: {
          status: 404,
          statusText: 'Not Found',
          data: { message: 'Mock route not found: ' + method + ' ' + url },
          headers: {},
          config,
        },
        message: 'Mock route not found',
      });
    }
    let parsedData: any = config.data;
    if (typeof parsedData === 'string') {
      try { parsedData = JSON.parse(parsedData); } catch { /* keep as-is */ }
    }
    const result = await matched.fn({
      url,
      method,
      data: parsedData,
      params: (config.params ?? {}) as Record<string, unknown>,
    });
    if (result.status >= 200 && result.status < 300) {
      return {
        data: result.data,
        status: result.status,
        statusText: 'OK',
        headers: {},
        config,
      } as any;
    }
    return Promise.reject({
      response: {
        status: result.status,
        statusText: 'Error',
        data: result.data,
        headers: {},
        config,
      },
      message: (result.data as any)?.message ?? 'Request failed',
    });
  };
}
