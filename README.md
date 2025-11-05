# Settlement Reminder Bot 🤖

Slack에서 정산 알림을 자동화하는 봇입니다.

**Queenit** (15, 말일) 및 **Paldogam** (5, 15, 25) 정산 일정을 추적하고,
결재 완료 시 자동으로 메시지를 업데이트하며, 이체 담당자에게 알립니다.

---

## 🌟 주요 기능

✅ **자동 정산 알림** - 정산일 2영업일 전 Slack 알림  
✅ **버튼 클릭 처리** - 결재완료 버튼 클릭 시 즉시 메시지 업데이트  
✅ **스레드 알림** - 완료 후 이체 담당자에게 스레드로 알림  
✅ **미결재 리마인드** - 09:00, 16:00 업무일 기준 자동 리마인드  
✅ **공휴일 처리** - 한국 공휴일 자동 계산  
✅ **빠른 응답** - Node.js + Vercel로 200ms 이하 응답시간

---

## 📁 프로젝트 구조

```
settlement-reminder-bot/
├── api/
│   ├── index.js          # 메인 핸들러 (Slack 이벤트 처리)
│   ├── config.js         # 설정 (채널, 사용자 ID 등)
│   └── utils.js          # 유틸 함수 (날짜, 영업일 계산)
├── package.json          # 의존성 명시
├── vercel.json           # Vercel 배포 설정
├── .env.example          # 환경변수 예제
├── .gitignore            # Git 무시 파일
└── README.md             # 이 파일
```

---

## 🚀 빠른 시작

### 1️⃣ GitHub 리포지토리 클론

```bash
git clone https://github.com/YOUR_USERNAME/settlement-reminder-bot.git
cd settlement-reminder-bot
```

### 2️⃣ 환경변수 설정

```bash
# .env 파일 생성
cp .env.example .env

# 다음 값들 입력
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=xxx...
```

### 3️⃣ 의존성 설치

```bash
npm install
```

### 4️⃣ 로컬 테스트

```bash
npm run dev
```

---

## 🔧 Slack 앱 설정

### 1. Slack API 접속
https://api.slack.com/apps → **Create New App** → **From scratch**

### 2. Bot Token 발급
- **OAuth & Permissions** 탭
- **Scopes** → **Bot Token Scopes** 추가:
  - `chat:write`
  - `chat:write.public`
  - `commands`
  - `app_mentions:read`

### 3. Signing Secret 복사
- **Basic Information** 탭
- **App Credentials** → **Signing Secret** 복사

### 4. Interactivity 설정
- **Interactivity & Shortcuts** → **Toggle On**
- **Request URL**: `https://your-project.vercel.app/api/index`

### 5. Workspace에 앱 설치
- **OAuth & Permissions** → **Install to Workspace**

---

## 📦 Vercel 배포

### 1️⃣ Vercel 계정 생성
https://vercel.com (GitHub로 가입 권장)

### 2️⃣ GitHub 연동
1. Vercel 대시보드 → **Add New** → **Project**
2. **Import Git Repository** 선택
3. `settlement-reminder-bot` 리포지토리 선택

### 3️⃣ 환경변수 설정
- **Settings** → **Environment Variables**
- 다음 변수들 추가:
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`
  - `CRON_SECRET`

### 4️⃣ 배포
Vercel이 자동으로 빌드 & 배포

```
✅ Deployment complete!
URL: https://settlement-reminder-bot.vercel.app
```

---

## 🔄 자동 배포

GitHub에서 코드를 `main` 브랜치에 푸시하면:

```bash
git add .
git commit -m "Fix: 버튼 응답 속도 개선"
git push origin main
```

**Vercel이 자동으로 감지 → 빌드 → 배포** 🚀

---

## 📝 사용 방법

### 1. 정산 알림 받기

정산일 2영업일 전에 Slack에 메시지 수신:

```
✨ @담당자님 퀸잇 11월 정산이(가) 결재 완료되었다면 결재완료 버튼을 눌러주세요

┌─ 퀸잇 11월 정산
└─ [결재완료] 버튼
```

### 2. 버튼 클릭

[결재완료] 버튼을 클릭하면:
- ✅ 메시지 자동 업데이트 (완료 상태로)
- 📧 이체 담당자에게 스레드로 알림 발송

### 3. 자동 리마인드

결재가 안 되면 09:00, 16:00에 업무일 기준으로 리마인드

---

## ⚙️ 설정 커스터마이징

### 채널/사용자 변경

`api/config.js` 수정:

```javascript
TEST_CHANNEL_ID: "C02DA0GK8MC",      // 원하는 채널 ID
NOTIFY_USER_ID: "U044Z1AB6CT",       // 알림 받을 사용자
ACTION_USER_ID: "U044Z1AB6CT",       // 이체 요청 받을 사용자
```

### 리마인드 시간 변경

```javascript
REMINDER_TIMES: ["09:00", "16:00"],  // 원하는 시간으로 변경
REMINDER_MAX_DAYS: 5                 // 최대 리마인드 일수
```

### 공휴일 추가

`api/utils.js`의 `isHoliday()` 함수에 추가:

```javascript
new Date(2025, 11, 25),  // 크리스마스
new Date(2026, 0, 1),    // 신정
// 추가적인 공휴일...
```

---

## 🐛 문제 해결

### "Cannot find module" 오류

```bash
npm install
git add package-lock.json
git commit -m "Update dependencies"
git push origin main
```

### 환경변수 인식 안 됨

- Vercel → **Settings** → **Environment Variables** 확인
- 수정 후 **Redeploy** 클릭

### Slack 요청 검증 실패

- `SLACK_SIGNING_SECRET`이 정확한지 확인
- Slack 앱 설정에서 다시 복사해서 설정

### 메시지 업데이트 안 됨

- Slack 앱이 `chat:write` 권한 있는지 확인
- Request URL이 정확한지 확인

---

## 📊 로그 확인

### Vercel 로그

Vercel 대시보드 → 프로젝트 → **Deployments** → **Function Logs**

### 로컬 개발 로그

```bash
npm run dev
# 터미널에서 요청/응답 로그 확인
```

---

## 🔐 보안

⚠️ **주의:**
- `.env` 파일은 절대 공개하지 마세요
- `SLACK_SIGNING_SECRET`은 매우 민감한 정보입니다
- `.gitignore`에 `.env`가 포함되어 있는지 확인하세요

---

## 📜 라이선스

MIT

---

## 💬 지원

문제가 있거나 기능 요청이 있으면 Issue를 생성해주세요.


---

**Happy Bot Deploying! 🚀**
