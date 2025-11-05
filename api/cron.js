// api/cron.js
// 정산 알림 자동화 (매일 09:00, 16:00 실행)

const axios = require('axios');
const CONFIG = require('./config');
const {
  stripTime,
  isSameDay,
  isHolidayOrWeekend,
  addBusinessDays,
  getPreviousBusinessDay,
  getNextBusinessDay,
  formatDate
} = require('./utils');

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
}

const slack = new SlackClient();

// ============================================
// 정산일 계산
// ============================================
function getQuenitSettlementDate(currentDate) {
  const y = currentDate.getFullYear();
  const m = currentDate.getMonth();
  const fifteenth = new Date(y, m, 15);
  const lastDay = new Date(y, m + 1, 0);

  const s15 = isHolidayOrWeekend(fifteenth)
    ? getPreviousBusinessDay(fifteenth)
    : fifteenth;
  const slast = isHolidayOrWeekend(lastDay)
    ? getPreviousBusinessDay(lastDay)
    : lastDay;

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
// 정산 알림 발송
// ============================================
async function sendSettlementReminder(channelId, userId, title, type) {
  console.log(`🔔 정산 알림 발송: ${title}`);

  const message = {
    channel: channelId,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<@${userId}>님 ${title}이(가) 결재 완료되었다면 결재완료 버튼을 눌러주세요`
        }
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: title
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "결재완료" },
            value: JSON.stringify({ type, title }),
            action_id: "settlement_approve_button"
          }
        ]
      }
    ]
  };

  const result = await slack.postMessage(channelId, {
    blocks: message.blocks
  });

  if (result) {
    console.log(`✅ 정산 알림 발송 완료: ${title}`);
  } else {
    console.error(`❌ 정산 알림 발송 실패: ${title}`);
  }
}

// ============================================
// 메인 크론 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log('⏰ 크론 작업 시작');
  console.log(`${'='.repeat(50)}\n`);

  try {
    // ============================================
    // 크론 시크릿 검증 (선택사항)
    // ============================================
    if (CONFIG.CRON_SECRET) {
      const authHeader = req.headers['authorization'];
      const secret = authHeader?.replace('Bearer ', '');

      if (secret !== CONFIG.CRON_SECRET) {
        console.warn('⚠️ 크론 시크릿 검증 실패');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      console.log('✅ 크론 시크릿 검증 성공');
    }

    // ============================================
    // 현재 날짜 계산
    // ============================================
    const today = stripTime(new Date());
    const todayStr = formatDate(today);
    console.log(`📅 오늘 날짜: ${todayStr}`);

    // 주말/휴일 체크
    if (isHolidayOrWeekend(today)) {
      console.log('📌 오늘은 주말/휴일이므로 알림을 생략합니다');
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'weekend_or_holiday'
      });
    }

    const channelId = CONFIG.TEST_CHANNEL_ID; // 필요시 FINANCE_CHANNEL_ID로 변경
    const notifyUserId = CONFIG.NOTIFY_USER_ID;
    let remindersSent = 0;

    // ============================================
    // Queenit 정산 알림 확인
    // ============================================
    console.log('\n🔍 Queenit 정산 확인');
    const quenitSettlement = getQuenitSettlementDate(today);

    if (quenitSettlement) {
      const quenitReminder = addBusinessDays(quenitSettlement, -2);
      const quenitReminderStr = formatDate(quenitReminder);
      console.log(`  정산일: ${formatDate(quenitSettlement)}`);
      console.log(`  알림일: ${quenitReminderStr} (정산 2영업일 전)`);

     if (isSameDay(today, quenitReminder)) {
        const title = `퀸잇 ${today.getMonth() + 1}월 정산`;
        await sendSettlementReminder(channelId, notifyUserId, title, 'queenit');
        remindersSent++;
      } else {
        console.log('  📌 오늘은 알림 예정일이 아닙니다');
      }
    } else {
      console.log('  📌 이번 달의 Queenit 정산이 없습니다');
    }

    // ============================================
    // Paldogam 정산 알림 확인
    // ============================================
    console.log('\n🔍 Paldogam 정산 확인');
    const paldogamDates = getPaldogamSettlementDates(today);

    if (paldogamDates.length === 0) {
      console.log('  📌 이번 달의 Paldogam 정산이 없습니다');
    } else {
      for (const settlementDate of paldogamDates) {
        const paldogamReminder = addBusinessDays(settlementDate, -2);
        const settlementDateStr = formatDate(settlementDate);
        const paldogamReminderStr = formatDate(paldogamReminder);

        console.log(`  정산일: ${settlementDateStr}`);
        console.log(`  알림일: ${paldogamReminderStr} (정산 2영업일 전)`);


        if (isSameDay(today, paldogamReminder)) {
          const title = getPaldogamTitle(settlementDate, today);
          await sendSettlementReminder(channelId, notifyUserId, title, 'paldogam');
          remindersSent++;
        } else {
          console.log('  📌 오늘은 알림 예정일이 아닙니다');
        }
      }
    }

    // ============================================
    // 결과 반환
    // ============================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 크론 작업 완료 - ${remindersSent}건 발송`);
    console.log(`${'='.repeat(50)}\n`);

    return res.status(200).json({
      ok: true,
      remindersSent,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ 크론 작업 오류:', err);
    console.error(err.stack);

    return res.status(500).json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
