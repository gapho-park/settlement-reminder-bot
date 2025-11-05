// api/index.js
const axios = require('axios');
const crypto = require('crypto');
const CONFIG = require('./config');
const { 
  stripTime, 
  isSameDay, 
  isHolidayOrWeekend,
  addBusinessDays,
  getPreviousBusinessDay,
  getNextBusinessDay
} = require('./utils');

// ============================================
// Slack 요청 검증
// ============================================
function verifySlackRequest(req) {
  const slackSigningSecret = CONFIG.SLACK_SIGNING_SECRET;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];
  
  if (!timestamp || !slackSignature) {
    console.warn('⚠️ Slack 타임스탬프 또는 시그니처 없음');
    return false;
  }
  
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.warn('⚠️ 요청이 너무 오래됨 (5분 이상)');
    return false;
  }

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hash = `v0=${crypto
    .createHmac('sha256', slackSigningSecret)
    .update(baseString)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(slackSignature)
    );
  } catch (err) {
    console.error('❌ 시그니처 검증 실패:', err.message);
    return false;
  }
}

// ============================================
// Slack API 클라이언트
// ============================================
class SlackClient {
  constructor() {
    this.baseURL = 'https://slack.com/api';
    this.headers = {
      'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
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

  async updateMessage(channel, ts, payload) {
    try {
      console.log(`🔄 chat.update 시도: channel=${channel}, ts=${ts}`);
      const response = await axios.post(`${this.baseURL}/chat.update`, {
        channel,
        ts,
        ...payload
      }, { headers: this.headers });
      
      if (!response.data.ok) {
        console.error('❌ chat.update 오류:', response.data.error);
        return false;
      }
      console.log('✅ 메시지 업데이트 성공');
      return true;
    } catch (err) {
      console.error('❌ updateMessage 실패:', err.message);
      return false;
    }
  }
}

const slack = new SlackClient();

// ============================================
// 버튼 클릭 처리
// ============================================
async function handleButtonClick(payload) {
  console.log("✅ Block actions 수신");
  
  const action = payload.actions?.[0];
  if (!action) {
    console.warn('⚠️ actions 없음');
    return { ok: true };
  }

  let reminder = null;
  try {
    reminder = JSON.parse(action.value);
  } catch (_) {
    console.warn('⚠️ reminder JSON 파싱 실패');
  }
  
  const title = reminder?.title || "(제목없음)";
  const channelId = payload.container?.channel_id || payload.channel?.id;
  const ts = payload.container?.message_ts || payload.message?.ts;
  const userId = payload.user?.id;

  console.log("DEBUG ctx:", JSON.stringify({ channelId, ts, userId }));

  // 완료 상태 블록
  const updatedBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *${title}* 결재 완료 처리됨`
      }
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `처리자: <@${userId}>` }
      ]
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 완료됨" },
          style: "primary",
          disabled: true
        }
      ]
    }
  ];

  // chat.update 시도
  let updated = false;
  if (channelId && ts) {
    console.log("🔄 chat.update 시도:", { channelId, ts });
    updated = await slack.updateMessage(channelId, ts, {
      blocks: updatedBlocks,
      text: `${title} 완료`
    });
    console.log("chat.update 결과:", updated);
  } else {
    console.warn("⚠️ channelId/ts 누락:", { channelId, ts });
  }

  // response_url 폴백
  if (!updated && payload.response_url) {
    console.log("💬 response_url 폴백 사용");
    try {
      await axios.post(payload.response_url, {
        blocks: updatedBlocks,
        text: `${title} 완료`,
        replace_original: true
      });
      console.log("✅ response_url 폴백 성공");
    } catch (err) {
      console.error("⚠️ response_url 폴백 실패:", err.message);
    }
  }

  // 스레드에 이체 요청 메시지
  if (channelId && ts) {
    const text = [
      `<@${CONFIG.ACTION_USER_ID}>님 정산대금 결재가 완료되었습니다. 이체요청을 해주세요.`,
      reminder ? `- 항목: ${reminder.title}` : null
    ].filter(Boolean).join("\n");

    const result = await slack.postMessage(channelId, {
      thread_ts: ts,
      text
    });
    
    if (result) {
      console.log("✅ 스레드 메시지 발송 성공");
    }
  }

  return { ok: true };
}

// ============================================
// 메인 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`📨 요청 수신: ${req.method}`);

  if (req.method === 'OPTIONS') {
    console.log('✅ OPTIONS 요청 응답');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.warn('❌ POST가 아닌 요청:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';

  return new Promise((resolve, reject) => {
    req.on('data', chunk => {
      body += chunk.toString();
    });
  
    req.on('end', async () => {
      try {
        req.rawBody = body;
  
        if (!verifySlackRequest(req)) {
          console.warn('⚠️ Slack 검증 실패');
          return resolve(res.status(401).json({ error: 'Unauthorized' }));
        }

        console.log('✅ Slack 검증 성공');

        // Payload 파싱 (x-www-form-urlencoded 형식 처리)
        let payload;
        try {
          if (body.startsWith('payload=')) {
            const params = new URLSearchParams(body);
            payload = JSON.parse(params.get('payload'));
          } else {
            payload = JSON.parse(body);
          }
        } catch (err) {
          console.error('❌ Payload 파싱 실패:', err.message);
          return resolve(res.status(400).json({ error: 'Invalid payload' }));
        }

        console.log('📋 Payload type:', payload.type);

        // URL Verification
        if (payload.type === 'url_verification') {
          console.log('✅ URL Verification 요청');
          return resolve(res.status(200).json({ 
            challenge: payload.challenge 
          }));
        }

        // Block Actions (버튼 클릭)
        if (payload.type === 'block_actions') {
          console.log('🎬 Block actions 처리 시작');
          const result = await handleButtonClick(payload);
          return resolve(res.status(200).json(result));
        }

        console.log('ℹ️ 처리되지 않은 이벤트 타입:', payload.type);
        return resolve(res.status(200).json({ ok: true }));

      } catch (err) {
        console.error('❌ 핸들러 오류:', err);
        return resolve(res.status(500).json({ 
          error: err.message 
        }));
      }
    });

    req.on('error', (err) => {
      console.error('❌ 요청 스트림 오류:', err);
      return resolve(res.status(500).json({ 
        error: 'Request stream error' 
      }));
    });
  });
};
