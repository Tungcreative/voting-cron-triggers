const crypto = require('crypto');

const PROJECT_ID = 'voting-a5e9b';
const DB_URL = `https://${PROJECT_ID}-default-rtdb.firebaseio.com`;
const APP_URL = 'https://voting.tungcreativevn.workers.dev';

async function getAccessToken(clientEmail, privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    };

    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsignedJwt = `${encode(header)}.${encode(claimSet)}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsignedJwt);
    sign.end();
    const signature = sign.sign(privateKey, 'base64url');
    const signedJwt = `${unsignedJwt}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
    });

    const tokenData = await tokenRes.json();
    return tokenData.access_token;
}

// Format giờ CHUẨN MÚI GIỜ VIỆT NAM (GMT+7)
function formatTimeVN(timestamp) {
    const d = new Date(timestamp + (7 * 3600 * 1000));
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

async function run() {
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
        console.error('Thiếu cấu hình biến môi trường FIREBASE_CLIENT_EMAIL hoặc FIREBASE_PRIVATE_KEY');
        process.exit(1);
    }

    const now = Date.now();
    const FIFTEEN_MINUTES = 15 * 60 * 1000;

    // Giờ Việt Nam hiện tại (GMT+7)
    const vnDate = new Date(now + (7 * 3600 * 1000));
    const vnHour = vnDate.getUTCHours(); // Giờ thực tế ở Việt Nam (0 - 23)
    const todayStr = vnDate.toISOString().split('T')[0];

    const startOfDay = new Date(`${todayStr}T00:00:00+07:00`).getTime();
    const endOfDay = new Date(`${todayStr}T23:59:59+07:00`).getTime();

    // 1. Quét dữ liệu từ Firebase
    const [matchesRes, sysRes, tokensRes, manualRes] = await Promise.all([
        fetch(`${DB_URL}/matches.json`),
        fetch(`${DB_URL}/system.json`),
        fetch(`${DB_URL}/fcm_tokens.json`),
        fetch(`${DB_URL}/manual_notifications.json`)
    ]);

    const matches = (await matchesRes.json()) || {};
    const system = (await sysRes.json()) || {};
    const tokensData = (await tokensRes.json()) || {};
    const manualData = (await manualRes.json()) || {};

    // Thiết bị hợp lệ kèm username
    const userDevices = Object.entries(tokensData).map(([key, val]) => ({
        dbKey: key,
        token: val.token,
        username: val.username || ''
    })).filter(d => Boolean(d.token));

    if (userDevices.length === 0) {
        console.log('Không tìm thấy thiết bị nào đã đăng ký nhận thông báo.');
        return;
    }

    const notificationsToSend = [];

    // A. Quét các trận đấu trong ngày
    const todayMatches = [];
    for (const id in matches) {
        const conf = matches[id]?.config;
        if (!conf) continue;

        const t1 = (conf.t1 || '').trim();
        const t2 = (conf.t2 || '').trim();

        // Bỏ qua trận chưa cấu hình tên
        if (!t1 || t1 === "Đội 1" || !t2 || t2 === "Đội 2") continue;

        // Trận đấu diễn ra trong ngày hôm nay
        if (conf.kickoff && conf.kickoff >= startOfDay && conf.kickoff <= endOfDay) {
            todayMatches.push({ id, t1, t2, kickoff: conf.kickoff, deadline: conf.deadline });
        }

        // Lấy danh sách những ai đã vote trận này
        const matchHistory = Object.values(matches[id]?.history || {});
        const votedUsernames = new Set(matchHistory.map(h => (h.name || '').trim().toLowerCase()));

        // Sắp mở cổng (trước 15 phút)
        if (conf.kickoff) {
            const diffKickoff = conf.kickoff - now;
            if (diffKickoff > 0 && diffKickoff <= FIFTEEN_MINUTES && !conf.notified_upcoming) {
                const targetTokens = userDevices
                    .filter(d => !d.username || !votedUsernames.has(d.username.trim().toLowerCase()))
                    .map(d => d.token);

                if (targetTokens.length > 0) {
                    notificationsToSend.push({
                        type: 'MATCH_UPCOMING',
                        matchId: id,
                        flagKey: 'notified_upcoming',
                        tag: `upcoming-${id}`,
                        title: 'SẮP ĐẾN GIỜ BÌNH CHỌN!',
                        body: `Trận ${t1} -${t2} sắp mở. Hãy vào dự đoán!`,
                        tokens: targetTokens
                    });
                }
            }
        }

        // Sắp đóng cổng (trước 15 phút)
        if (conf.deadline) {
            const diffDeadline = conf.deadline - now;
            if (diffDeadline > 0 && diffDeadline <= FIFTEEN_MINUTES && !conf.notified_closing) {
                const targetTokens = userDevices
                    .filter(d => !d.username || !votedUsernames.has(d.username.trim().toLowerCase()))
                    .map(d => d.token);

                if (targetTokens.length > 0) {
                    notificationsToSend.push({
                        type: 'MATCH_CLOSING',
                        matchId: id,
                        flagKey: 'notified_closing',
                        tag: `closing-${id}`,
                        title: 'SẮP ĐÓNG CỔNG BÌNH CHỌN!',
                        body: `Trận ${t1} -${t2} sắp đóng. Hãy vào dự đoán!`,
                        tokens: targetTokens
                    });
                }
            }
        }
    }

    // B. LỊCH THI ĐẤU TRONG NGÀY (DAILY SUMMARY)
    // NGHIÊM CẤM GỬI LÚC NỬA ĐÊM: Chỉ gửi trong khung giờ sáng từ 07:00 đến 09:00 (giờ VN)
    if (vnHour >= 7 && vnHour <= 9 && todayMatches.length > 0 && system.daily_summary_date !== todayStr) {
        todayMatches.sort((a, b) => a.kickoff - b.kickoff);
        const matchLines = todayMatches.map(m => `• ${formatTimeVN(m.kickoff)}: ${m.t1} - ${m.t2}`).join('\n');

        notificationsToSend.push({
            type: 'DAILY_SUMMARY',
            tag: 'daily-schedule',
            title: `TRẬN MỞ HÔM NAY (${todayMatches.length} TRẬN)`,
            body: matchLines,
            dateKey: todayStr,
            tokens: userDevices.map(d => d.token)
        });
    }

    // C. Quét thông báo thủ công từ Admin (BTC)
    if (manualData) {
        for (const key in manualData) {
            const item = manualData[key];
            if (item && item.status === 'pending') {
                notificationsToSend.push({
                    type: 'MANUAL_ANNOUNCEMENT',
                    manualKey: key,
                    tag: `manual-${key}`,
                    title: item.title,
                    image: item.image || '',
                    body: item.body,
                    tokens: userDevices.map(d => d.token)
                });
            }
        }
    }

    if (notificationsToSend.length === 0) {
        console.log(`[${todayStr} ${vnHour}h VN] Không có thông báo nào cần gửi.`);
        return;
    }

    // 2. Lấy Google Access Token
    const accessToken = await getAccessToken(clientEmail, privateKey);

    // 3. Tiến hành gửi FCM
    for (const item of notificationsToSend) {
        console.log(`\n========================================`);
        console.log(`Đang gửi: "${item.title}" tới ${item.tokens.length} thiết bị...`);

        const webpushNotif = {
            title: item.title,
            body: item.body,
            icon: `${APP_URL}/logo.png`,
            badge: `${APP_URL}/logo_tc2.png`,
            tag: item.tag || 'general-tag',
            renotify: true,
            requireInteraction: true
        };
        if (item.image && typeof item.image === 'string' && item.image.startsWith('http')) {
            webpushNotif.image = item.image;
        }

        const sendRequests = item.tokens.map(async (token) => {
            const messageBody = {
                message: {
                    token: token,
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: webpushNotif,
                        fcm_options: { link: `${APP_URL}/home.html` }
                    },
                    data: {
                        title: item.title,
                        body: item.body,
                        image: item.image || '',
                        url: `${APP_URL}/home.html`,
                        type: String(item.type || 'GENERAL')
                    }
                }
            };

            try {
                const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(messageBody)
                });

                const resJson = await res.json();
                if (!res.ok) {
                    if (res.status === 404 || resJson?.error?.details?.[0]?.errorCode === 'UNREGISTERED') {
                        const matchedDevice = userDevices.find(d => d.token === token);
                        if (matchedDevice) {
                            await fetch(`${DB_URL}/fcm_tokens/${matchedDevice.dbKey}.json`, { method: 'DELETE' });
                            console.log(`🗑️ Đã xóa token hết hạn: ${matchedDevice.dbKey}`);
                        }
                    }
                } else {
                    console.log(`✅ Gửi thành công tới: ...${token.slice(-8)}`);
                }
            } catch (err) {
                console.error(`❌ Lỗi FCM:`, err.message);
            }
        });

        await Promise.all(sendRequests);

        // 4. Đánh dấu đã gửi
        if (item.type === 'DAILY_SUMMARY') {
            await fetch(`${DB_URL}/system/daily_summary_date.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.dateKey)
            });
            console.log(`Đã lưu ngày gửi tóm tắt: ${item.dateKey}`);
        } else if (item.type === 'MANUAL_ANNOUNCEMENT') {
            await fetch(`${DB_URL}/manual_notifications/${item.manualKey}.json`, {
                method: 'DELETE'
            });
            console.log(`Đã gửi Push và xóa sạch hàng đợi: ${item.manualKey}`);
        } else {
            await fetch(`${DB_URL}/matches/${item.matchId}/config/${item.flagKey}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(true)
            });
        }
    }
}

run().catch(err => {
    console.error('Lỗi cron:', err);
    process.exit(1);
});
