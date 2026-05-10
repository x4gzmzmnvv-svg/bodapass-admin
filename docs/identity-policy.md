# 보다패스 — 신원·식별·관리 정책

**최종 확정일:** 2026-05-05
**적용 범위:** 회사 / 현장 / 근로자 / 반장 / 협력 관계

---

## 1. 식별자 체계

각 엔티티는 「내부 ID + 자연 식별자 + 표시 코드」 3계층 분리 원칙을 따른다.
(Stripe `cus_xxx` + 이메일 + 표시명, Shopify `gid` + handle 패턴 동일)

### 1.0 엔티티별 식별자 매핑

| 엔티티 | 내부 ID (DB FK) | 자연 식별자 (검증·법적) | 표시 코드 (UI·문서) |
|---|---|---|---|
| **회사** | `companyId` (UUID/AI) | 사업자번호 `123-45-67890` | `C-26-000001` |
| **현장** | `siteId` (UUID/AI) | (회사 + 현장명) | `P-26-28-001` |
| **근로자** | `memberId` (UUID/AI) | 주민번호·외등번호·여권 | `W-26-000123` |

**왜 3계층 분리가 필요한가**
- **합병·분할**: 회사 합병 시 사업자번호는 변경되지만, 표시 코드는 양쪽 보존 가능
- **외국 법인**: 사업자번호 형식 다를 수 있음 — 표시 코드는 통일된 형식
- **보안**: 사업자번호는 외부 노출 시 도용 우려, 내부 UUID는 외부에 노출 X
- **마이그레이션**: DB 이전·시스템 변경 시 내부 ID 재발급 가능, 표시 코드는 영구 불변

### 1.1 관계 식별자

| 관계 | 표현 방식 | 발급 단위 |
|---|---|---|
| **협력 관계** | (siteId + companyId) 페어 | SiteCompany 행 |
| **채용 관계** | (companyId + memberId) 페어 | Employment 행 |

별도 「브릿지 코드」는 없다. 페어 자체가 관계를 표현.

### 1.2 회사 코드 형식 (`C-YY-NNNNNN`)

- **C** — Company (모든 회사 공통 prefix)
- **YY** — 보다패스 등록 연도 (`26` = 2026)
- **NNNNNN** — 6자리 시리얼 (companyId 해시 기반 결정적, 1~999,999)

영구 1회 발급, 변경 불가. 회사 합병 시에도 양쪽 코드 모두 보존 (이력 추적용).

### 1.3 현장 코드 형식 (`P-YY-RR-NNN`)

- **YY** — 발행 연도 마지막 2자리 (`26` = 2026)
- **RR** — 광역시도 코드 2자리 (행정안전부 표준)
  - 11 서울 · 26 부산 · 27 대구 · 28 인천 · 29 광주 · 30 대전 · 31 울산 · 36 세종
  - 41 경기 · 42 강원 · 43 충북 · 44 충남 · 45 전북 · 46 전남 · 47 경북 · 48 경남 · 50 제주
- **NNN** — 시리얼 발행번호 (siteId 해시 기반 결정적, 001~999)

### 1.4 워커 관리번호 형식 (`W-YY-NNNNNN`)

- **W** — Worker (모든 근로자 공통 prefix, 성별 무관)
- **YY** — 발급 연도 (출생 연도가 아님 — PII 노출 최소화)
- **NNNNNN** — 6자리 시리얼 (1 ~ 999,999, 멤버 ID 해시 기반 결정적)

**성별 prefix를 두지 않는 이유**
- 개인정보보호법: 성별은 민감정보에 준함
- 남녀고용평등법: 채용·근무 과정 성별 노출은 차별 위험
- 트랜스젠더·법적 성별 변경자: 코드 변경 강제 시 정체성 노출 우려
- 비공개 희망자: 코드만 봐도 성별 노출 (PII)

### 1.5 관계 표현 예시

```
협력 관계: P-26-28-001 + C-26-000234 (사업자번호 234-56-78901)
           → 「B철근(주)이 인천 동현 현장에 하도급 참여」

채용 관계: C-26-000234 + W-26-000123
           → 「김철수가 B철근(주)에 채용됨」
```

같은 워커가 여러 회사·현장에서 일해도 (현장 + 회사 + 워커) 페어 조합으로 모두 명확히 격리됨.
DB 조인은 내부 ID(`siteId`/`companyId`/`memberId`)로, UI·문서는 표시 코드로.

---

## 2. 신뢰등급 (Trust Tier) 4단계

| Tier | 얼굴 | 신분증 | 본인 통장 | 시스템 등록 |
|---|---|---|---|---|
| **T1** 정식 | ✓ | ✓ | ✓ | ✓ |
| **T2** 부분 | ✓ | ✓ | ✗ (가족·반장) | ✓ |
| **T3** 제한 | ✓ | ✗ | ✗ (가족·반장) | ✓ |
| **T4** 미인증 | ✗ | ✗ | ✗ | 별도 출입기록만 |

### 2.1 Tier별 자동 처리 범위

| 기능 | T1 | T2 | T3 | T4 |
|---|:---:|:---:|:---:|:---:|
| 얼굴 출퇴근 인증 | ✓ | ✓ | ✓ | ✗ |
| 신분증 검증 | ✓ | ✓ | ✗ | ✗ |
| 4대보험 자동 신고 | ✓ | ✓ (제한) | ✗ | ✗ |
| 소득세 원천징수 | ✓ | ✓ | △ 반장 | ✗ |
| 임금 자동 지급 | ✓ 본인 | △ 가족·반장 | △ 가족·반장 | ✗ 현금 |
| 출역 일수 추적 | ✓ | ✓ | ✓ | △ 반장 입력만 |
| 퇴직공제 적립 | ✓ | ✓ | ✗ | ✗ |
| 산재 보호 | ✓ 자동 | ✓ 자동 | ✓ 회사 단체 | ✗ 회사 책임 |
| 도용 차단 | RRN unique | RRN unique | 얼굴 unique | 차단 불가 |

### 2.2 Tier 1·2·3 — 시스템 정식 등록

- **얼굴 등록**이 시스템 가입의 최소 베이스라인
- 얼굴 미등록자는 시스템 가입 불가
- 관리번호 형식은 모든 Tier 동일 (`W-26-000123`)
- Tier는 별도 배지로 표시 (UI에서 구분)

### 2.3 Tier 4 — 별도 출입기록 + 출력 후 폐기

- 시스템에 정식 등록하지 않음 (워커 마스터 미생성)
- 별도 `Tier4EntryLog` 테이블에 출입만 기록
- 필드: `일시 / 현장 / 반장이 적은 이름 / 반장 서명`
- 정기 출력 (보고서·노무비 정산) 후 **30일 자동 폐기**
- 폐기 이력만 감사로그에 영구 보존

### 2.4 자동 Tier 판정 로직

```typescript
function decideTrustTier(reg: RegisterMemberRequest): 1 | 2 | 3 {
  const hasFace = !!reg.faceImageId;       // 필수
  const hasId   = !!reg.idNumber;
  const hasBank = !!reg.accountNumber && reg.accountHolder === reg.name;

  if (!hasFace) {
    throw new Error('얼굴 등록은 필수입니다');
  }
  if (hasFace && hasId && hasBank) return 1;
  if (hasFace && hasId)            return 2;
  return 3;
}
```

### 2.5 Tier 승급 (자동)

- 정보 추가 입력 시 즉시 승급 (본사 승인 불필요)
- 관리번호는 그대로 유지
- 승급 이력 감사로그 기록 + 본인 휴대폰 알림

---

## 3. 데이터 모델

### 3.1 Company (회사 마스터)

```typescript
interface Company {
  id: string;                   // 내부 UUID (DB FK, 외부 노출 X)
  bizNo: string;                // 사업자번호 자연키 (123-45-67890)
  companyCode: string;          // 표시 코드 C-26-000001
  name: string;
  representative?: string;
  ownerUserId?: string;         // 본사 관리자 계정
  createdAt: string;
  // 외부 API·UI 응답엔 companyCode + name만 노출, id·bizNo는 권한 체크 후
}
```

### 3.2 Worker (근로자 마스터, 영구)

```typescript
interface Worker {
  id: string;                   // 내부 UUID (DB FK)
  workerCode: string;           // W-26-000123 / W-26-000456
  trustTier: 1 | 2 | 3;
  idType: 1 | 2 | 3;            // 1 주민번호 / 2 외등 / 3 여권
  idNumberRaw?: string;         // 권한자만 평문
  idNumberMasked: string;       // 일반 표시
  faceVectorId: string;         // 얼굴 인식 모델 ID
  name: string;
  sex: 'M' | 'F';
  birthDate: string;
  phone: string;
  // 영구 마스터 — 회사·현장 무관, 한 번만 발급
}
```

### 3.3 SiteCompany (협력 관계 — 현장 × 회사)

```typescript
interface SiteCompany {
  id: string;                   // siteCompanyId — 행의 PK
  siteId: string;               // 내부 FK — Site.id
  companyId: string;            // 내부 FK — Company.id (UI는 companyCode)
  role: '원도급' | '하도급' | '협력사' | '감리' | '품질' | '안전';
  trade?: string;               // 철근 / 전기 / 설비 (하도급일 때 의미)
  contractAmount?: number;
  startDate?: string;
  endDate?: string;
  status: 'INVITED' | 'ACTIVE' | 'PAUSED' | 'TERMINATED' | 'BLOCKED';
  joinedAt: string;
  // (siteId + companyId) 페어로 unique
}
```

### 3.4 Employment (채용 관계 — 회사 × 워커 × 현장)

```typescript
interface Employment {
  id: string;                   // employmentId — 행의 PK
  companyId: string;            // 내부 FK — Company.id
  workerId: string;             // 내부 FK — Worker.id (UI는 workerCode)
  siteId: string;               // 내부 FK — Site.id
  foremanId?: string;           // 자기 참조 — 같은 회사 내 반장 Employment.id
  trade?: string;               // 형틀 / 철근 / 전기 / 미장 등
  dailyWage: number;
  startDate: string;
  endDate?: string;
  status: 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  paymentAccountType: 'OWN' | 'FAMILY' | 'FOREMAN';  // 임금 지급 계좌 명의자
  identityTier: 1 | 2 | 3;      // 채용 시점 신뢰등급 스냅샷 (Worker.trustTier 와 별개)
  // (companyId + workerId + siteId) 페어로 unique
}
```

### 3.5 Attendance (출퇴근)

```typescript
interface Attendance {
  employmentId: string;         // Employment.id 참조 (어느 채용 관계인지 명확화)
  workerId: string;             // 빠른 조회용 — Worker.id 직접 참조
  siteId: string;
  date: string;
  gongsu: number;
  checkInMethod: 'FACE' | 'MANUAL';
  checkOutMethod: 'FACE' | 'MANUAL' | 'EXCEPTION';
  // 모든 회사·현장에서 같은 workerId로 자동 누적,
  // 회사별 합산은 employmentId 기준
}
```

### 3.6 Wage (임금 정산)

```typescript
interface Wage {
  employmentId: string;         // Employment.id 참조 (정산 단위)
  workerId: string;
  companyId: string;
  period: string;              // '2026-04'
  totalDays: number;
  totalAmount: number;
  recipientName?: string;       // T2/T3 대리 수령자
  recipientAccount?: string;
  // 출역 + 일당 → 자동 계산
  // paymentAccountType 은 Employment 에서 참조
}
```

### 3.7 Tier4EntryLog (별도 임시 출입 기록)

```typescript
interface Tier4EntryLog {
  id: string;
  enteredAt: string;
  exitedAt?: string;
  siteId: string;
  recordedName: string;          // 반장이 기입한 이름
  foremanId: string;             // 책임 반장
  foremanSignature: string;      // 전자서명
  exportedAt?: string;           // 보고서 출력 일시
  purgeScheduledAt?: string;     // 출력 후 30일
  // 워커 마스터(Worker) 미생성, 출력 후 30일 자동 폐기
}
```

---

## 4. 등록 절차 (반장 + 본인 실명 인증)

### 4.1 일반 등록 흐름

```
[근로자 등록 화면 — 반장이 진행]
  ① 반장이 근로자 정보 입력 (이름·휴대폰·생년월일)
       ↓
  ② 근로자 본인 휴대폰으로 SMS 실명 인증
       · 통신사 명의 = 입력 이름 일치 확인
       · 본인이 직접 「동의합니다」 회신
       · 인증 미완료 시 → 등록 대기 상태 (반장에게 알림)
       ↓
  ③ 얼굴 등록 (필수)
       · 95%+ 일치 워커 발견 시:
           「[기존 워커명 (W-26-000123)] 과 동일인입니까?」
           반장이 확인 → Yes: 통합 / No: 신규 진행
       ↓
  ④ 신분증 OCR (T1·T2)
       · OCR 자동 추출 + RRN/외등번호/여권 검증
       · OCR 실패 시 반장이 수기 보정 후 「내가 확인했음」 동의
       ↓
  ⑤ 통장 정보 (선택)
       · 본인 명의 → T1
       · 가족·반장 명의 → T2/T3 (별도 동의 절차 없음)
       ↓
  ⑥ Tier 자동 판정 + 관리번호 발급 (W-26-000123)
```

### 4.2 도용 차단 메커니즘

```
RRN/외등번호 unique constraint (DB 레벨)
  · 같은 RRN으로 다른 이름 등록 시도 → 즉시 거부
  · 본사 알림 + 감사로그 영구 보존

얼굴 벡터 매칭
  · 95%+ 유사도 자동 비교
  · 매칭 시 「동일인 추정」 알림 (반장이 결정)
  · 위·변조 신분증으로 도용해도 얼굴은 못 속임

휴대폰 명의 검증
  · 통신사 API로 명의자 = 입력 이름 일치 확인
  · 불일치 시 가입 차단
```

---

## 5. 회사 간 데이터 통합·격리

### 5.1 통합 (workerCode 기반 누적)

- 한 워커가 여러 회사에서 일해도 모든 출역·임금·교육이수가 `workerCode`로 자동 합산
- 누적 경력·이수 자격증·퇴직공제 적립일수 평생 관리
- 산재 발생 시 과거 이력으로 책임 회사 명확화

### 5.2 격리 (Employment 단위)

- 회사는 자기 회사의 Employment 데이터만 조회 가능
- 다른 회사의 채용 정보·계좌·계약 내용 노출 X
- 본인 동의 시 「누적 경력 N년」 같은 요약 정보만 회사 간 공유 가능

### 5.3 반장의 다중 회사 소속

- 반장도 워커 마스터 1개 (한 사람 = 한 워커)
- 회사별로 별도 Employment 행 (`role: 'foreman'`)
- 한 반장이 동시에 여러 회사 소속 가능
- 회사별 권한·접근 영역은 Employment 단위로 격리

---

## 6. 본인 권리 — 가입 해지 (탈퇴)

### 6.1 탈퇴 요청 흐름

```
[근로자 마이페이지 — 향후 별도 앱 연동]
  「시스템 탈퇴 요청」 버튼 클릭
       ↓
  본인 SMS 인증 (도용 방지)
       ↓
  탈퇴 사유 선택 (선택, 통계용)
       ↓
  본사 대기열에 「탈퇴 요청」 등록
       ↓
  본사 처리 (자동 또는 수동, 7일 이내)
       ↓
  Worker 마스터 「익명화 처리」
    · 이름 → 「익명-{workerCode 뒷4자리}」
    · 주민번호·생년월일 → NULL
    · 휴대폰·계좌 → NULL
    · 얼굴 데이터 → 영구 삭제
       ↓
  Employment·Attendance·Wage 기록은 회사 측
  법적 보관 의무(3~5년)로 익명화된 형태로 유지
       ↓
  보관 기간 만료 시 hard delete
```

### 6.2 회사 동의 불필요

- 노동법상 근로자의 개인정보 삭제권은 회사가 거부 못함
- 단, 회사의 법적 보관 의무(노무비 5년·임금 3년)는 익명화된 형태로 충족

---

## 7. 본사 정책 통제

### 7.1 Tier 분포 모니터링

```
[현장별 신뢰등급 분포 — 본사 통계 화면]
  인천 동현 (P-26-28-001)
    T1  ████████ 65%   (정상 채용)
    T2  ██▌      18%   (계좌만 부분)
    T3  █▌       11%   (신분증 미제출)
    T4  ▌         6%   (전부 부분)

  → T2+T3 비율 29% — 「양호」
  → 30% 초과 시 노란 경고
```

### 7.2 한도 초과 처리

```
T2+T3 비율이 본사 설정 한도 초과 시
  → 본사 관리자에게 「⚠ [현장명] T3 비율 35% (한도 30% 초과)」 알림
  → 본사 화면에서 결정:
     · 가입 차단 → 신규 T2/T3 가입 자동 거부 (T1만 가능)
     · 예외 승인 → 일정 기간만 한도 무시 (사유 기록 필수)
     · 한도 상향 → 본사 차원 정책 변경
```

---

## 8. 임금 지급 정책

### 8.1 Tier별 지급 흐름

```
T1 (본인 통장)
  보다패스 → 본인 계좌 자동 송금

T2/T3 (가족·반장 통장)
  보다패스 → 등록된 대리 수령자 계좌로 송금
  · 별도 동의 절차 없음 (본인이 입력한 정보 = 본인 책임)
  · 매월 송금 시 본인 휴대폰에 알림 (분쟁 방지)

T4 (현금)
  시스템에서 임금 처리 X
  반장이 「현금 지급함」 체크만
  본사는 「T4 임금 N건 = M원」 통계만 집계
```

### 8.2 법적 주의사항

- 근로기준법 제43조: 임금은 근로자에게 직접 지급
- 가족·대리인 지급은 본인 동의 시에만 합법
- **본 시스템에선 별도 동의 절차를 두지 않음. 회사가 자체적으로 동의서 보관 권장.**

---

## 9. 변경 이력

| 일자 | 변경 내용 |
|---|---|
| 2026-05-05 | 최초 정책 확정 (5종 식별자 + 4 Tier + 등록 절차) |
| 2026-05-05 | 워커 관리번호 형식 변경 — 성별 prefix 제거 (`M/F-YY-NNNNN` → `W-YY-NNNNNN`) |
| 2026-05-05 | 회사 식별자 3계층 분리 — 내부 UUID(`companyId`) + 자연키(사업자번호) + 표시코드(`C-26-000001`) |
| 2026-05-05 | SiteCompany 모델 확장 — `siteCompanyId` 명시, role 6종(원도급/하도급/협력사/감리/품질/안전), `specialty` → `trade` |
| 2026-05-05 | Employment 인터페이스 신설 — `(companyId + workerId + siteId)` 페어 기반, `paymentAccountType` + `identityTier` 추가 |
