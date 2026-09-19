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

function formatTime(timestamp) {
    const d = new Date(timestamp);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
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

    // Giờ Việt Nam (GMT+7)
    const todayStr = new Date(now + 7 * 3600 * 1000).toISOString().split('T')[0];
    const startOfDay = new Date(`${todayStr}T00:00:00+07:00`).getTime();
    const endOfDay = new Date(`${todayStr}T23:59:59+07:00`).getTime();

    // 1. Quét dữ liệu từ Firebase
    const [matchesRes, sysRes, tokensRes, manualRes] = await Promise.all([
        fetch(`${DB_URL}/matches.json`),
        fetch(`${DB_URL}/system.json`),
        fetch(`${DB_URL}/fcm_tokens.json`),
        fetch(`${DB_URL}/manual_notifications.json`)
    ]);

    const matches = await matchesRes.json();
    const system = (await sysRes.json()) || {};
    const tokensData = await tokensRes.json();
    const manualData = await manualRes.json();

    if (!tokensData) {
        console.log('Không tìm thấy token người dùng nào trong database.');
        return;
    }

    const tokens = Object.values(tokensData).map(item => item.token).filter(Boolean);
    if (tokens.length === 0) {
        console.log('Danh sách token rỗng.');
        return;
    }
    console.log(`Tìm thấy ${tokens.length} thiết bị đã đăng ký nhận thông báo.`);

    const notificationsToSend = [];

    // A. Quét các trận đấu tự động
    const todayMatches = [];
    if (matches) {
        for (const id in matches) {
            const conf = matches[id]?.config;
            if (!conf) continue;

            const t1 = conf.t1 || 'Đội 1';
            const t2 = conf.t2 || 'Đội 2';

            if (conf.kickoff && conf.kickoff >= startOfDay && conf.kickoff <= endOfDay) {
                todayMatches.push({ id, t1, t2, kickoff: conf.kickoff, deadline: conf.deadline });
            }

            // Sắp mở cổng (trước 15p)
            if (conf.kickoff) {
                const diffKickoff = conf.kickoff - now;
                if (diffKickoff > 0 && diffKickoff <= FIFTEEN_MINUTES && !conf.notified_upcoming) {
                    notificationsToSend.push({
                        type: 'MATCH_UPCOMING',
                        matchId: id,
                        flagKey: 'notified_upcoming',
                        tag: `upcoming-${id}`,
                        title: 'SẮP ĐẾN GIỜ BÌNH CHỌN!',
                        body: `Trận ${t1}-${t2} sẽ mở trong ít phút nữa. Hãy dự đoán ngay!`
                    });
                }
            }

            // Sắp đóng cổng (trước 15p)
            if (conf.deadline) {
                const diffDeadline = conf.deadline - now;
                if (diffDeadline > 0 && diffDeadline <= FIFTEEN_MINUTES && !conf.notified_closing) {
                    notificationsToSend.push({
                        type: 'MATCH_CLOSING',
                        matchId: id,
                        flagKey: 'notified_closing',
                        tag: `closing-${id}`,
                        title: 'SẮP ĐÓNG CỔNG BÌNH CHỌN!',
                        body: `Trận ${t1}-${t2} sẽ đóng trong ít phút nữa. Hãy dự đoán ngay!`
                    });
                }
            }
        }
    }

    // B. Lịch thi đấu trong ngày
    if (todayMatches.length > 0 && system.daily_summary_date !== todayStr) {
        todayMatches.sort((a, b) => a.kickoff - b.kickoff);
        const matchLines = todayMatches.map(m => `• ${formatTime(m.kickoff)}: ${m.t1} vs ${m.t2}`).join('\n');

        notificationsToSend.push({
            type: 'DAILY_SUMMARY',
            tag: 'daily-schedule',
            title: `LỊCH BÌNH CHỌN HÔM NAY (${todayMatches.length} TRẬN)`,
            body: matchLines,
            dateKey: todayStr
        });
    }

    // C. Quét thông báo thủ công từ Admin
    if (manualData) {
        for (const key in manualData) {
            const item = manualData[key];
            if (item && item.status === 'pending') {
                notificationsToSend.push({
                    type: 'MANUAL_ANNOUNCEMENT',
                    manualKey: key,
                    tag: `manual-${key}`,
                    title: item.title,
                    image: item.image || '', // Chỉ nhận nếu là URL ảnh
                    body: item.body
                });
            }
        }
    }

    if (notificationsToSend.length === 0) {
        console.log('Không có thông báo nào cần gửi lúc này.');
        return;
    }

    // 2. Lấy Google Access Token
    const accessToken = await getAccessToken(clientEmail, privateKey);

    // 3. Gửi thông báo và xử lý cờ trạng thái
    for (const item of notificationsToSend) {
        console.log(`\n========================================`);
        console.log(`Đang gửi: "${item.title}"...`);

        // Chuẩn hóa payload notification (FCM v1 không chấp nhận trường rỗng "")
        const notifPayload = {
            title: item.title,
            body: item.body
        };
        if (item.image && typeof item.image === 'string' && item.image.startsWith('http')) {
            notifPayload.image = item.image;
        }

        const webpushNotif = {
            icon: `${APP_URL}/logo.png`,
            badge: `${APP_URL}/logo_tc2.png`,
            tag: item.tag || 'general-tag',
            renotify: true,
            requireInteraction: true
        };
        if (item.image && typeof item.image === 'string' && item.image.startsWith('http')) {
            webpushNotif.image = item.image;
        }

        const sendRequests = tokens.map(async (token) => {
            const messageBody = {
                message: {
                    token: token,
                    notification: notifPayload,
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: webpushNotif,
                        fcm_options: { link: `${APP_URL}/home.html` }
                    },
                    data: {
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
                    console.error(`❌ FCM Thất bại với token ...${token.slice(-8)} (Mã ${res.status}):`, JSON.stringify(resJson));
                } else {
                    console.log(`✅ Gửi thành công tới: ...${token.slice(-8)}`);
                }
            } catch (err) {
                console.error(`❌ Lỗi kết nối FCM:`, err.message);
            }
        });

        // Chờ toàn bộ request gửi đi hoàn tất
        await Promise.all(sendRequests);

        // 4. Dọn dẹp / Cập nhật cờ sau khi gửi xong
        if (item.type === 'DAILY_SUMMARY') {
            await fetch(`${DB_URL}/system/daily_summary_date.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.dateKey)
            });
            console.log(`Đã cập nhật ngày gửi tóm tắt: ${item.dateKey}`);
        } else if (item.type === 'MANUAL_ANNOUNCEMENT') {
            await fetch(`${DB_URL}/manual_notifications/${item.manualKey}.json`, {
                method: 'DELETE'
            });
            console.log(`Đã hoàn tất gửi Push và xóa sạch hàng đợi: ${item.manualKey}`);
        } else {
            await fetch(`${DB_URL}/matches/${item.matchId}/config/${item.flagKey}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(true)
            });
            console.log(`Đã cập nhật cờ ${item.flagKey} cho trận ${item.matchId}`);
        }
    }
}

run().catch(err => {
    console.error('Lỗi khi chạy cron:', err);
    process.exit(1);
});
