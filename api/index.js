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
  
  // 타임스탬프가 5분 이상 지난 요청은 거부 (replay attack 방지)
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
// 정산일 계산 함수
// ============================================
function getQuenitSettlementDate(currentDate) {
  const y = currentDate.getFullYear();
  const m = currentDate.getMonth();
  const fifteenth = new Date(y, m, 15);
  const lastDay = new Date(y, m + 1, 0);

  const s15 = isHolidayOrWeekend(fifteenth) ? getPreviousBusinessDay(fifteenth) : fifteenth;
  const slast = isHolidayOrWeekend(lastDay) ? getPreviousBusinessDay(lastDay) : lastDay;

  if (s15 >= currentDate) return stripTime(s15);
  if (slast >= currentDate) return stripTime(slast);
  return null;
}

function getPaldogamSettlementDates(currentDate) {
  const y = currentDate.getFullYear();
  const m = currentDate.getMonth();
  const days = [5, 15, 25];
  const out = [];
  
  days.forEach(d => {
    const dt = new Date(y, m, d);
    const s = isHolidayOrWeekend(dt) ? getNextBusinessDay(dt) : dt;
    if (stripTime(s) >= currentDate) out.push(stripTime(s));
  });
  
  return out;
}

function getPaldogamTitle(settlementDate, today) {
  const month = today.getMonth() + 1;
  const day = settlementDate.getDate();
  if (day >= 5 && day <= 10) return `팔도감 ${month}월 3차정산`;
  if (day >= 15 && day <= 20) return `팔도감 ${month}월 2차정산`;
  if (day >= 25) return `팔도감 ${month}월 1차정산`;
  return `팔도감 ${month}월 정산`;
}

// ============================================
// 버튼 클릭 처리 (메인 로직)
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

  // ============================================
  // 1단계: 완료 상태 블록 생성
  // ============================================
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

  // ============================================
  // 2단계: chat.update로 원본 메시지 업데이트
  // ============================================
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

  // ============================================
  // 3단계: response_url 폴백 (chat.update 실패시)
  // ============================================
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

  // ============================================
  // 4단계: 스레드에 이체 요청 메시지 발송
  // ============================================
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
// 메인 핸들러 (Vercel Serverless Function)
// ============================================
module.exports = async (req, res) => {
  console.log(`📨 요청 수신: ${req.method}`);

  // OPTIONS 요청 처리
  if (req.method === 'OPTIONS') {
    console.log('✅ OPTIONS 요청 응답');
    return res.status(200).end();
  }

  // POST 요청만 처리
  if (req.method !== 'POST') {
    console.warn('❌ POST가 아닌 요청:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ============================================
  // 요청 본문 수집 (Slack 검증용)
  // ============================================
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
          resolve(res.status(401).json({ error: 'Unauthorized' }));
          return;
        }
  
        // payload 파싱 수정
        let payload;
        if (body.startsWith('payload=')) {
          // x-www-form-urlencoded 형식
          const params = new URLSearchParams(body);
          payload = JSON.parse(params.get('payload'));
        } else {
          // JSON 형식
          payload = JSON.parse(body);
        }

        console.log('✅ Slack 검증 성공');

        // ============================================
        // JSON 파싱
        // ============================================
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          console.error('❌ JSON 파싱 실패:', err.message);
          return resolve(res.status(400).json({ error: 'Invalid JSON' }));
        }

        console.log('📋 Payload type:', payload.type);

        // ============================================
        // URL Verification 처리
        // ============================================
        if (payload.type === 'url_verification') {
          console.log('✅ URL Verification 요청 - Challenge 응답');
          return resolve(res.status(200).json({ 
            challenge: payload.challenge 
          }));
        }

        // ============================================
        // Block Actions 처리 (버튼 클릭)
        // ============================================
        if (payload.type === 'block_actions') {
          console.log('🎬 Block actions 처리 시작');
          const result = await handleButtonClick(payload);
          return resolve(res.status(200).json(result));
        }

        // ============================================
        // 기타 이벤트
        // ============================================
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
