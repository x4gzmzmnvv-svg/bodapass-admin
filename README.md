# 일당백 관리자 웹 (ilgampack-admin)

건설 현장 출퇴근 관리 플랫폼 **일당백** 의 PC 관리자 웹입니다.
모바일 앱(`/ilgampack`) 과 같은 React + TypeScript + Vite 스택을 쓰며,
백엔드 없이 단독 실행되도록 axios 어댑터를 통한 **Mock Backend** 가 내장돼 있습니다.

---

## 빠른 시작 (개발자용)

```bash
cd ilgampack-admin
npm install
cp .env.example .env       # 필요 시 VITE_API_BASE_URL 수정
npm run dev                # http://localhost:5174
npm run build              # dist/ 생성
npm run typecheck          # tsc --build (타입 검증만)
```

데모 계정: `akoma` / `akoma`  또는  `admin` / `admin`

> Windows 에서 `npm run dev` 가 동작하려면 Node 18+ 가 필요합니다.
> Mock 데이터는 브라우저 `localStorage` 에 저장돼 새로고침 후에도 유지됩니다.
> 시드 데이터로 되돌리려면 브라우저 콘솔에서 `localStorage.clear()` 후 새로고침.

---

## 기술 스택

| 영역 | 라이브러리 / 도구 | 비고 |
|------|---------------------|------|
| 프레임워크 | React 18 + TypeScript 5 | |
| 빌드 | Vite 5 | HMR + esbuild |
| 라우팅 | react-router-dom v6 | |
| HTTP | axios 1 | adapter 패턴으로 mock 처리 |
| 스타일 | 페이지별 plain CSS + 전역 디자인 토큰 (`globals.css`) | Tailwind 미사용 |
| 차트 | (필요 시 추후 추가) | 현재는 자체 SVG/CSS 진행바 |

---

## 화면 / 기능 — 현재 빌드 상태

### 인증
- 로그인 (와이어프레임 002)
- 회원가입 3-step (003~005) — 약관 / 정보 입력 + 공인인증서 / 완료
- 가입 후 자동 로그인 → 대시보드 진입

### 대시보드
- **등록 현장 표 (엑셀 행/열)** — 클릭 시 KPI 가 그 현장 기준으로 갱신
- **예산 대비 지급률 KPI 6 항목** (한 줄, 픽토그램 + 진행바 + %)
  - 연간 지급액, 지급예정 — `도급금액` 분모
  - 공제금액, 소득세, 40H공단, 퇴직금(R) — `연간 지급액` 분모
- **등록 반장** (전체 반장) / **근무중 반장** (선택 현장의 반장) 2 카드 분리
- 현장 등록 / 반장 등록 다이얼로그

### 현장 관리
- 좌측 목록 + 우측 상세 (와이어프레임 025)

### 팀원 관리
- **반장 카드 그리드** + 반장 클릭 시 **그 반장이 관리하는 팀원 모달**
- **전체 팀원 표** (한 줄 12 컬럼) — # / 이름 / 직종 / 일당 / 전화 / 주민번호 / 계좌 / 현장 / 반장 / 등록 / 상태 / 관리
- 직종 검색 셀렉트 (`RoleSelect`) — 직무범위.xlsx 의 303개 직종
- **대면 등록** — 신분증·얼굴·통장 + 전자동의서 PART 1·2·3 분리 동의
- **온라인 등록** — 이름·휴대폰만 입력 → SMS 발송, 팀원이 자기 폰에서 직접 등록
- 등록 / 초대 시 **반장 선택** 가능 (현장 변경 시 반장 자동 리셋)
- **수정 / 삭제** 버튼 — 직종·일당·현장·반장·상태 부분 수정 (PATCH `/team/members/:id`)

### 출퇴근 현황 (3등분 레이아웃)
- 좌: 팀원 요약 리스트 (이름/직종/공수/일수)
- 중: 선택 팀원의 **달력형 공수** (7×6 셀, 휴일/오늘/미래 구분)
- 우: 감사 로그 (강제 처리·일괄 퇴근·공수 입력 기록)
- 각 셀 클릭 → **공수 직접 입력 다이얼로그** (사유 빠른 선택: 통신 두절·용역업체·외부 자재·기타)
- 일괄 퇴근 처리 / 출·퇴근 강제 처리 다이얼로그
- 한국 공휴일 표시 (`utils/holidays.ts`)

### 임금 / 노임비 / 퇴직금
- 월간 임금 / 퇴직금 적립 (와이어프레임 030, 034)
- 알림톡 발송 시뮬레이션 + 디스패치 로그 (`utils/messageTemplates.ts`)

### 공통 / 인프라
- 권한 가드 + 토큰 자동 갱신 (`api/client.ts`)
- 좌측 검정 사이드바 + 상단 헤더 (`layouts/AdminShell.tsx`)
- 디자인 토큰 (`styles/globals.css`)

---

## 폴더 구조

```
src/
├── api/
│   ├── client.ts              axios 인스턴스 + 401 재시도 + 토큰 갱신
│   ├── mockBackend.ts         모든 라우트의 mock 응답 (localStorage 영속)
│   ├── auth.ts / .types.ts    /auth/* 엔드포인트
│   ├── site.ts / .types.ts    /sites, /foremen, /dashboard
│   ├── team.ts / .types.ts    /team/members (CRUD), /team/online-invite
│   ├── attendance.ts / .types 출퇴근 / 공수 / 감사 로그
│   └── wage.ts / .types.ts    임금 · 퇴직금
├── components/
│   ├── Icon.tsx               외부 의존성 없는 SVG 아이콘
│   ├── PageHeader.tsx         페이지 상단 타이틀
│   ├── Modal.tsx              범용 모달
│   ├── Field.tsx              라벨·인풋·에러 폼 컴포넌트
│   ├── RoleSelect.tsx         303개 직종 검색 셀렉트
│   ├── SiteRegisterDialog.tsx
│   ├── ForemanRegisterDialog.tsx
│   └── MiniCalendar.tsx
├── data/
│   ├── jobs.json / jobs.ts    직무범위.xlsx 추출 직종 데이터
│   └── jobCategories.ts       상위 카테고리
├── hooks/
│   └── useAuth.ts
├── layouts/
│   ├── AdminShell.tsx         가드 + 사이드바 + 헤더 + <Outlet/>
│   ├── Sidebar.tsx
│   └── TopBar.tsx
├── pages/
│   ├── LoginPage.tsx, signup/Signup{1,2,3}Page.tsx
│   ├── DashboardPage.tsx
│   ├── SiteListPage.tsx
│   ├── TeamListPage.tsx, TeamRegisterPage.tsx, TeamInvitePage.tsx
│   ├── AttendancePage.tsx
│   ├── WagePage.tsx
│   ├── PrivacyPolicyPage.tsx
│   ├── NotificationCenterPage.tsx
│   └── PlaceholderPage.tsx
├── routes/AppRouter.tsx
├── styles/globals.css         디자인 토큰
└── utils/
    ├── gongsu.ts              8h(07~15)=1.0 공수 / 4h당 0.5 적층 / max 2.0
    ├── holidays.ts            2024~2027 한국 공휴일 (음력 포함)
    ├── wageCalc.ts            4대보험 · 소득세 · 주민세 (Excel 공식)
    ├── messageTemplates.ts    SMS / 알림톡 템플릿
    └── validation.ts          전화·사업자번호 등
```

---

## 디자인 토큰

`src/styles/globals.css` 의 CSS 변수만 바꾸면 전체 색감을 일괄 조정할 수 있습니다.

| 토큰 | 값 |
|------|-----|
| `--color-primary` | `#15A09F` |
| `--color-primary-dark` | (자동 파생) |
| `--color-brand-red` | `#EE3A3A` (사이드바 "일당백" 로고) |
| `--sidebar-bg` | `#1A1A1A` |
| `--sidebar-w` | `240px` (`72px` collapsed) |
| `--header-h` | `64px` |
| `--content-max-w` | `1440px` |

---

## API / Mock Backend

`src/api/mockBackend.ts` 가 모든 엔드포인트를 axios `defaults.adapter` 로 가로채서 응답합니다.
실서버 연결 시:

1. `src/api/*.types.ts` 의 DTO 가 그대로 백엔드 명세가 됩니다.
2. `.env` 에 `VITE_USE_MOCK=false`, `VITE_API_BASE_URL=https://api.your-domain.com`
3. `src/api/client.ts` 의 `setupMockBackend(client)` 호출만 제거하면 끝.
4. mock DB는 `localStorage['ilgampack_admin:mockdb']` 에 저장됩니다 — 디버깅 시 콘솔에서 직접 확인 가능.

### 인증 흐름

- 모든 요청에 `Authorization: Bearer {accessToken}` 자동 첨부
- 401 응답 시 `/auth/refresh` 1회 시도 → 실패 → `/login` 리다이렉트 + 원래 경로 보존
- 토큰 키: `ilgampack_admin:*` (모바일 앱 `ilgampack:*` 과 분리)

---

## 라우팅

| 경로 | 화면 |
|------|------|
| `/login` | 로그인 |
| `/signup`, `/signup?step={2,3}` | 회원가입 3-step |
| `/` | 대시보드 |
| `/site` | 현장 관리 |
| `/team` | 팀원 관리 (반장 카드 + 전체 팀원 표) |
| `/team/new` | 팀원 등록 (대면) |
| `/team/invite` | 팀원 등록 (온라인 SMS) |
| `/attendance` | 출퇴근 현황 (3등분) |
| `/wage` | 임금 / 노임비 / 퇴직금 |
| `/notifications` | 알림 센터 |
| `/privacy` | 개인정보 처리방침 |

비인증 상태에서 보호된 경로 진입 시 `/login` 으로 리다이렉트, 로그인 후 원래 가려던 곳으로 돌아옵니다.

---

## 개발자 핸드오프 (코드 받기 / 수정 / 업로드)

### 1) 코드 받기
- 본 README 와 같은 폴더에 위치한 zip(`ilgampack-admin.zip`)을 압축 해제하거나
- Git 으로 옮기려면 아래 단계.

### 2) Git 저장소에 올리기

```bash
cd ilgampack-admin
git init
git add -A
git commit -m "chore: initial commit (handoff)"
git branch -M main
git remote add origin https://github.com/<your-org>/ilgampack-admin.git
git push -u origin main
```

`.gitignore` 에 `node_modules`, `dist`, `.env`, `*.log` 가 포함돼 있으니 그대로 커밋해도 안전합니다.

### 3) 수정하기

```bash
npm install                # 최초 1회
npm run dev                # 개발 서버 (HMR)
# 코드 수정 → 저장 → 브라우저 자동 반영
npm run typecheck          # TS 빌드만 (타입 검증)
npm run build              # dist/ 정적 자산 생성
```

### 4) 배포 (정적 호스팅)

`npm run build` 의 `dist/` 폴더를 그대로 정적 호스팅(S3 + CloudFront / Vercel / Netlify / Nginx) 에 올리면 됩니다.
SPA 라 모든 경로를 `/index.html` 로 fallback 시키도록 호스팅 설정 필요.

### 5) 백엔드 연결로 전환

`.env`:

```
VITE_USE_MOCK=false
VITE_API_BASE_URL=https://api.your-domain.com
```

그리고 `src/api/client.ts` 의 mock 설치 라인을 환경 변수 분기로 감싸면 됩니다.

---

## TODO / 개선 후보

- [ ] 토큰을 `localStorage` 대신 `httpOnly` 쿠키로 (XSS 방어)
- [ ] 관리자 권한별 메뉴 가시성 (`OWNER/MANAGER/STAFF`)
- [ ] CSRF 토큰 (실서버 연결 시)
- [ ] 비밀번호 정책(특수문자/길이) UI
- [ ] 로그인 시도 rate limit (서버 측)
- [ ] E2E 테스트 (Playwright) — 핵심 플로우 자동화
- [ ] 다국어 지원 (현재는 한국어 고정)

---

## 라이선스

내부용. 외부 배포 / 공개 저장소 업로드 전 검토 필요.
