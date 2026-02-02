// api/delete-last.js
// 가장 최근 봇 메시지 삭제 엔드포인트
// 사용: /api/delete-last?channel=finance&type=all

const axios = require('axios');
const CONFIG = require('./config');

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

  async getConversationHistory(channel, limit = 100) {
    try {
      console.log(`📜 채널 메시지 조회: channel=${channel}, limit=${limit}`);
      const resp = await axios.get(`${this.baseURL}/conversations.history`, {
        headers: this.headers,
        params: { channel, limit }
      });

      if (!resp.data?.ok) {
        console.error('❌ conversations.history 오류:', resp.data?.error);
        return [];
      }

      console.log(`✅ ${resp.data.messages.length}개 메시지 조회 성공`);
      return resp.data.messages || [];
    } catch (err) {
      console.error('❌ getConversationHistory 실패:', err.message);
      return [];
    }
  }

  async deleteMessage(channel, ts) {
    try {
      console.log(`🗑️ 메시지 삭제 시도: channel=${channel}, ts=${ts}`);
      const resp = await axios.post(`${this.baseURL}/chat.delete`, {
        channel,
        ts
      }, { headers: this.headers });

      if (!resp.data?.ok) {
        console.error('❌ chat.delete 오류:', resp.data?.error);
        return false;
      }

      console.log('✅ 메시지 삭제 성공');
      return true;
    } catch (err) {
      console.error('❌ deleteMessage 실패:', err.message);
      return false;
    }
  }

  async getBotUserId() {
    try {
      const resp = await axios.get(`${this.baseURL}/auth.test`, {
        headers: this.headers
      });
      return resp.data?.user_id;
    } catch (err) {
      console.error('❌ getBotUserId 실패:', err.message);
      return null;
    }
  }
}

const slack = new SlackClient();

// ============================================
// 메인 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log('🗑️ 최근 메시지 삭제 요청');
  console.log(`${'='.repeat(50)}\n`);

  try {
    // 파라미터 읽기
    const { channel, type, count } = req.query;

    // 채널 ID 결정
    let channelId;
    if (channel === 'finance') {
      channelId = CONFIG.FINANCE_CHANNEL_ID;
    } else if (channel === 'test') {
      channelId = CONFIG.TEST_CHANNEL_ID;
    } else if (channel) {
      channelId = channel; // 직접 채널 ID 입력
    } else {
      channelId = CONFIG.FINANCE_CHANNEL_ID; // 기본값
    }

    console.log(`📢 대상 채널: ${channelId}`);
    console.log(`🎯 삭제 타입: ${type || 'all'}`);
    console.log(`🔢 삭제 개수: ${count || 1}`);

    // 봇 사용자 ID 조회
    const botUserId = await slack.getBotUserId();
    if (!botUserId) {
      return res.status(500).json({
        ok: false,
        error: '봇 사용자 ID를 가져올 수 없습니다'
      });
    }
    console.log(`🤖 봇 사용자 ID: ${botUserId}`);

    // 채널 메시지 조회
    const messages = await slack.getConversationHistory(channelId, 50);

    if (messages.length === 0) {
      return res.status(200).json({
        ok: true,
        deleted: 0,
        message: '조회된 메시지가 없습니다'
      });
    }

    // 봇이 보낸 메시지만 필터링
    const botMessages = messages.filter(msg => {
      // 봇이 보낸 메시지인지 확인
      if (msg.user !== botUserId && msg.bot_id !== botUserId) return false;

      // type에 따라 필터링
      if (type === 'settlement') {
        // 정산 알림만
        const text = msg.text || '';
        const hasSettlementButton = (msg.blocks || []).some(
          b => b.type === 'actions' && b.elements?.some(el => el.action_id === 'settlement_approve_button')
        );
        return text.includes('퀸잇') || text.includes('팔도감') || hasSettlementButton;
      } else if (type === 'groupware') {
        // 그룹웨어 알림만
        const hasGroupwareButton = (msg.blocks || []).some(
          b => b.type === 'actions' && b.elements?.some(el => el.action_id === 'groupware_deadline_button')
        );
        return hasGroupwareButton;
      } else if (type === 'reminder') {
        // 리마인더만
        const text = msg.text || '';
        return text.startsWith('⏰ *리마인더*');
      }

      // type이 'all' 또는 없으면 모든 봇 메시지
      return true;
    });

    if (botMessages.length === 0) {
      return res.status(200).json({
        ok: true,
        deleted: 0,
        message: '삭제할 봇 메시지가 없습니다'
      });
    }

    // 삭제할 메시지 개수 결정
    const deleteCount = count ? Math.min(parseInt(count), botMessages.length) : 1;
    const messagesToDelete = botMessages.slice(0, deleteCount);

    console.log(`\n📋 삭제할 메시지: ${messagesToDelete.length}개`);

    // 메시지 삭제
    let deletedCount = 0;
    for (const msg of messagesToDelete) {
      const text = msg.text || '';
      const preview = text.substring(0, 50).replace(/\n/g, ' ');
      console.log(`🗑️ 삭제 중: ${preview}...`);

      const deleted = await slack.deleteMessage(channelId, msg.ts);
      if (deleted) {
        deletedCount++;
        console.log(`✅ 삭제 완료: ${msg.ts}`);
      } else {
        console.error(`❌ 삭제 실패: ${msg.ts}`);
      }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 삭제 작업 완료 - ${deletedCount}/${messagesToDelete.length}건 성공`);
    console.log(`${'='.repeat(50)}\n`);

    return res.status(200).json({
      ok: true,
      deleted: deletedCount,
      total: messagesToDelete.length,
      channel: channelId,
      type: type || 'all',
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ 메시지 삭제 오류:', err);
    console.error(err.stack);

    return res.status(500).json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
