// 가장 최근 메시지 삭제 스크립트
// 실행: node scripts/delete-latest-message.js [채널ID]
// 채널ID를 지정하지 않으면 FINANCE_CHANNEL_ID 사용

require('dotenv').config();
const axios = require('axios');
const CONFIG = require('../api/config');

const CHANNEL_ID = process.argv[2] || CONFIG.FINANCE_CHANNEL_ID;

if (!CHANNEL_ID) {
  console.error('❌ 채널 ID가 필요합니다. 사용법: node scripts/delete-latest-message.js [채널ID]');
  process.exit(1);
}

async function deleteLatestMessage() {
  console.log(`🗑️ 채널(${CHANNEL_ID})의 가장 최근 메시지 삭제 시작\n`);

  try {
    // 1. 채널 메시지 조회 (가장 최근 1개만)
    const response = await axios.get('https://slack.com/api/conversations.history', {
      headers: {
        'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      params: {
        channel: CHANNEL_ID,
        limit: 1
      }
    });

    if (!response.data.ok) {
      console.error('❌ 메시지 조회 실패:', response.data.error);
      return;
    }

    const messages = response.data.messages || [];
    
    if (messages.length === 0) {
      console.log('📭 삭제할 메시지가 없습니다.');
      return;
    }

    const latestMessage = messages[0];
    console.log(`📋 가장 최근 메시지 발견:`);
    console.log(`   - 타임스탬프: ${latestMessage.ts}`);
    console.log(`   - 사용자: ${latestMessage.user || '알 수 없음'}`);
    console.log(`   - 텍스트: ${latestMessage.text?.substring(0, 100) || '(텍스트 없음)'}...\n`);

    // 2. 메시지 삭제
    console.log('🗑️ 메시지 삭제 중...');
    const deleteResponse = await axios.post('https://slack.com/api/chat.delete', {
      channel: CHANNEL_ID,
      ts: latestMessage.ts
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (deleteResponse.data.ok) {
      console.log(`✅ 메시지 삭제 완료: ${latestMessage.ts}`);
    } else {
      console.error(`❌ 삭제 실패: ${deleteResponse.data.error}`);
      console.error(`   참고: 봇이 작성한 메시지만 삭제할 수 있습니다.`);
    }
  } catch (err) {
    console.error('❌ 오류 발생:', err.message);
  }
}

deleteLatestMessage().catch(console.error);
