// scripts/send-feb-1-alert.js
// 2월 1일 팔도감 정산 알림 수동 발송 스크립트

const axios = require('axios');
const CONFIG = require('../api/config');

// ============================================
// 설정
// ============================================
const APPROVAL_FLOW = {
  paldogam: {
    steps: [
      { role: 'settlement_owner', userId: 'U0499M26EJ2', message: '{title} 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting_manager', userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'finance_manager', userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
    ]
  }
};

// ============================================
// Slack API 클라이언트
// ============================================
class SlackClient {
  constructor() {
    this.baseURL = 'https://slack.com/api';
    this.headers = {
      Authorization: `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    };
  }

  async postMessage(channel, payload) {
    try {
      console.log(`📤 Slack 메시지 전송: channel=${channel}`);
      const response = await axios.post(`${this.baseURL}/chat.postMessage`, {
        channel,
        ...payload
      }, { headers: this.headers });

      if (!response.data.ok) {
        console.error('❌ Slack API 오류:', response.data.error);
        return null;
      }
      console.log('✅ 메시지 전송 성공:', response.data.ts);
      return response.data;
    } catch (err) {
      console.error('❌ postMessage 실패:', err.message);
      return null;
    }
  }
}

const slack = new SlackClient();

// ============================================
// 정산 제목 생성
// ============================================
function getSettlementTitle(platform, day, month) {
  if (platform === 'paldogam') {
    if (day === 1) return `팔도감 ${month}월 3차 정산대금`;
    if (day === 11) return `팔도감 ${month}월 1차 정산대금`;
    if (day === 21) return `팔도감 ${month}월 2차 정산대금`;
  }
  return `${platform} ${month}월 정산대금`;
}

// ============================================
// 첫 번째 승인 알림 발송
// ============================================
async function sendFirstApprovalAlert(platform, month, day, channelId) {
  const flow = APPROVAL_FLOW[platform];
  const firstStep = flow.steps[0];
  const title = getSettlementTitle(platform, day, month);

  const message = `<@${firstStep.userId}>님 ${firstStep.message.replace('{title}', title)}`;

  const payload = {
    text: message,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: message }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '완료' },
            value: JSON.stringify({ platform, step: 0, month, day, title }),
            action_id: 'settlement_approve_button'
          }
        ]
      }
    ]
  };

  const result = await slack.postMessage(channelId, payload);

  if (result) {
    console.log(`✅ ${platform} ${month}월 첫 번째 알림 발송 성공`);
    return true;
  } else {
    console.error(`❌ ${platform} ${month}월 알림 발송 실패`);
    return false;
  }
}

// ============================================
// 메인 실행
// ============================================
async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log('📢 2월 1일 팔도감 정산 알림 수동 발송');
  console.log(`${'='.repeat(50)}\n`);

  try {
    const platform = 'paldogam';
    const month = 2;
    const day = 1;
    const channelId = CONFIG.FINANCE_CHANNEL_ID;

    console.log(`📅 날짜: ${month}월 ${day}일`);
    console.log(`📢 플랫폼: ${platform}`);
    console.log(`💬 채널: ${channelId}\n`);

    const success = await sendFirstApprovalAlert(platform, month, day, channelId);

    if (success) {
      console.log(`\n${'='.repeat(50)}`);
      console.log('✅ 알림 발송 완료');
      console.log(`${'='.repeat(50)}\n`);
      process.exit(0);
    } else {
      console.log(`\n${'='.repeat(50)}`);
      console.log('❌ 알림 발송 실패');
      console.log(`${'='.repeat(50)}\n`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ 스크립트 실행 오류:', err);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
