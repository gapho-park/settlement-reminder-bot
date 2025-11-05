// api/config.js
const CONFIG = {
  // Slack 토큰 및 시크릿 (환경변수에서 로드)
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,

  // 채널 및 사용자 ID
  TEST_CHANNEL_ID: "U044Z1AB6CT",           // 테스트 채널/DM
  FINANCE_CHANNEL_ID: "C02DA0GK8MC",       // finance-finance 채널
  NOTIFY_USER_ID: "U06K3R3R6QK",           // 알림 받을 담당자
  ACTION_USER_ID: "U044Z1AB6CT",           // 결재완료 후 이체 요청 받을 사람

  // 미결재 리마인드 정책
  REMINDER_TIMES: ["09:00", "16:00"],      // 업무일 기준 리마인드 시각(HH:mm)
  REMINDER_MAX_DAYS: 5,                    // 최초 알림 이후 최대 리마인드 일수

  // 타임존
  TIMEZONE: "Asia/Seoul"
};

// 환경변수 검증
function validateConfig() {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = required.filter(key => !CONFIG[key]);

  if (missing.length > 0) {
    console.error('❌ 필수 환경변수 누락:', missing.join(', '));
    console.error('⚠️ .env 파일 또는 Vercel 환경변수 설정 필요');
    // 개발 환경에서만 경고, 프로덕션에서는 계속 진행
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

validateConfig();

module.exports = CONFIG;
