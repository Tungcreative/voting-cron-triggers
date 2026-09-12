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

async function run() {
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

    if (!clientEmail || !privateKey) {
        console.error('Thiếu cấu hình biến môi trường FIREBASE_CLIENT_EMAIL hoặc FIREBASE_PRIVATE_KEY');
        process.exit(1);
    }

    const now = Date.now();
    const FIFTEEN_MINUTES = 15 * 60 * 1000;

    // 1. Quét danh sách trận đấu trên Firebase
    const matchesRes = await fetch(`${DB_URL}/matches.json`);
    const matches = await matchesRes.json();
    if (!matches) {
        console.log('Không có dữ liệu trận đấu.');
        return;
    }

    const upcomingMatches = [];
    for (const id in matches) {
        const conf = matches[id]?.config;
        if (!conf || !conf.kickoff) continue;

        const diff = conf.kickoff - now;
        if (diff > 0 && diff <= FIFTEEN_MINUTES && !conf.notified_upcoming) {
            upcomingMatches.push({ id, conf });
        }
    }

    if (upcomingMatches.length === 0) {
        console.log('Không có trận nào sắp diễn ra trong 15 phút tới cần gửi thông báo.');
        return;
    }

    // 2. Lấy toàn bộ danh sách FCM Tokens
    const tokensRes = await fetch(`${DB_URL}/fcm_tokens.json`);
    const tokensData = await tokensRes.json();
    if (!tokensData) {
        console.log('Không tìm thấy token người dùng nào.');
        return;
    }

    const tokens = Object.values(tokensData).map(item => item.token).filter(Boolean);
    if (tokens.length === 0) {
        console.log('Danh sách token rỗng.');
        return;
    }

    // 3. Lấy access token từ Google
    const accessToken = await getAccessToken(clientEmail, privateKey);

    // 4. Phát thông báo
    for (const match of upcomingMatches) {
        const t1 = match.conf.t1 || 'Đội 1';
        const t2 = match.conf.t2 || 'Đội 2';

        console.log(`Đang gửi thông báo cho trận: ${t1} - ${t2}...`);

        const sendRequests = tokens.map(token => {
            return fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: {
                        token: token,
                        notification: {
                            title: 'SẮP ĐẾN GIỜ BÌNH CHỌN!',
                            body: `Trận đấu ${t1} - ${t2} sẽ mở cổng trong ít phút nữa. Vào dự đoán ngay!`
                        },
                        webpush: {
                            headers: {
                                Urgency: 'high'
                            },
                            notification: {
                                icon: `${APP_URL}/logo.png`,
                                badge: `${APP_URL}/logo_tc2.png`,
                                tag: 'upcoming-match',
                                renotify: true,
                                requireInteraction: true,
                                vibrate: [200, 100, 200]
                            },
                            fcm_options: {
                                link: `${APP_URL}/home`
                            }
                        },
                        data: { 
                            matchId: match.id,
                            url: `${APP_URL}/home`
                        }
                    }
                })
            });
        });

        await Promise.all(sendRequests);

        // Đánh dấu cờ đã gửi lên Firebase
        await fetch(`${DB_URL}/matches/${match.id}/config/notified_upcoming.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(true)
        });

        console.log(`Đã gửi thành công cho trận ${match.id} và cập nhật trạng thái Firebase.`);
    }
}

run().catch(err => {
    console.error('Lỗi khi chạy cron:', err);
    process.exit(1);
});
