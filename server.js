const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const fs = require('fs');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let players = {};
let taggerId = null;
let lastTaggerId = null; // 최근 술래 (봇 무한 추격 방지용)

// --- AI 봇 시스템 ---
const BOT_PERSONALITIES = {
    AGGRESSIVE: 'aggressive', // 공격형: 끈질긴 추격, 아이템 즉시 사용
    CAREFUL: 'careful',       // 신중형: 도주 우선, 쉴드 선호
    PLAYFUL: 'playful'        // 장난꾸러기: 랜덤 행동, 바나나 설치
};

class Bot {
    constructor(id) {
        this.id = id;
        this.playerId = id; // 클라이언트 호환성
        this.nickname = '🤖Bot_' + id.slice(0, 4);
        this.color = this.getRandomColor();
        this.personality = this.getRandomPersonality();

        const spawn = getRandomSpawn();
        this.x = spawn.x;
        this.y = spawn.y;
        this.targetX = this.x; // 이동 목표
        this.targetY = this.y;

        // 상태
        this.hasItem = null;
        this.hasShield = false;
        this.isSpeeding = false;
        this.isSlipped = false; // 미끄러짐 상태 추가

        // AI 제어 변수
        this.lastMoveTime = 0;
        this.changeDirTime = 0;
        this.moveDir = { x: 0, y: 0 };
    }

    getRandomColor() {
        const colors = ['#e67e22', '#1abc9c', '#9b59b6', '#e84393', '#f1c40f', '#3498db']; // 밝고 선명한 색상들
        return colors[Math.floor(Math.random() * colors.length)];
    }

    getRandomPersonality() {
        const types = Object.values(BOT_PERSONALITIES);
        return types[Math.floor(Math.random() * types.length)];
    }

    update() {
        if (this.isSlipped) return; // 미끄러짐 상태면 이동 불가

        // 봇 AI 로직 (틱마다 호출)
        // 1. 목표 설정 (추격/도주/배회)
        if (taggerId === this.id) {
            this.chaseTarget(); // 술래일 때
        } else {
            this.fleeOrWander(); // 생존자일 때
        }

        // 2. 이동 실행 (속도 보정: 클라이언트 60fps * 3px ~= 180px/sec. 서버 10fps 이므로 틱당 18px 필요)
        const speed = this.isSpeeding ? 25 : 15;

        // X축 이동 시도
        let nextX = this.x + this.moveDir.x * speed;
        // 맵 경계 체크
        if (nextX < 0) nextX = 0;
        if (nextX > (COLS - 1) * TILE_SIZE) nextX = (COLS - 1) * TILE_SIZE;

        if (checkBotWallCollision(nextX, this.y)) {
            // X축 막힘 -> 멈추고 방향 전환 검토
            // nextX = this.x; // (부드러운 슬라이딩을 위해 막히면 이동 안함)
            // 벽에 비비지 않게 랜덤 반사 or 캔슬
            this.changeDirection();
        } else {
            this.x = nextX;
        }

        // Y축 이동 시도
        let nextY = this.y + this.moveDir.y * speed;
        if (nextY < 0) nextY = 0;
        if (nextY > (ROWS - 1) * TILE_SIZE) nextY = (ROWS - 1) * TILE_SIZE;

        if (checkBotWallCollision(this.x, nextY)) {
            this.changeDirection();
        } else {
            this.y = nextY;
        }

        // 3. 아이템 사용 로직 (성격 반영)
        this.useItemLogic();
    }

    chaseTarget() {
        // 가장 가까운 플레이어 찾기
        let closest = null;
        let minDist = Infinity;

        for (const pid in players) {
            if (pid === this.id) continue;
            // 방금 나를 잡은 사람(또는 내가 잡은 사람)은 잠시 무시
            if (pid === lastTaggerId) continue;

            const p = players[pid];
            const dist = Math.hypot(p.x - this.x, p.y - this.y);
            if (dist < minDist) {
                minDist = dist;
                closest = p;
            }
        }

        if (closest) {
            // 타겟 방향으로 이동
            const dx = closest.x - this.x;
            const dy = closest.y - this.y;
            const angle = Math.atan2(dy, dx);

            // 약간의 랜덤성 추가 (완벽한 추적 방지)
            this.moveDir.x = Math.cos(angle);
            this.moveDir.y = Math.sin(angle);
        } else {
            this.wander();
        }
    }

    fleeOrWander() {
        if (!taggerId) return this.wander();

        const tagger = players[taggerId];
        if (!tagger) return this.wander();

        const dist = Math.hypot(tagger.x - this.x, tagger.y - this.y);

        if (dist < 200) { // 술래가 가까우면 도주
            const dx = this.x - tagger.x;
            const dy = this.y - tagger.y;
            const angle = Math.atan2(dy, dx);
            this.moveDir.x = Math.cos(angle);
            this.moveDir.y = Math.sin(angle);
        } else {
            this.wander();
        }
    }

    wander() {
        if (Date.now() > this.changeDirTime) {
            this.changeDirection();
        }
    }

    changeDirection() {
        // 플레이어처럼 8방향 중 하나로 이동 (대각선 포함)
        const dirs = [
            { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, // 상하좌우
            { x: 0.7, y: -0.7 }, { x: 0.7, y: 0.7 }, { x: -0.7, y: -0.7 }, { x: -0.7, y: 0.7 } // 대각선
        ];
        this.moveDir = dirs[Math.floor(Math.random() * dirs.length)];
        this.changeDirTime = Date.now() + 1000 + Math.random() * 2000;
    }

    useItemLogic() {
        if (!this.hasItem) return;

        // 성격별 사용 확률
        let useChance = 0.05; // 틱당 5% (빈도 상향)

        if (this.personality === BOT_PERSONALITIES.AGGRESSIVE) {
            if (this.hasItem === 'speed') useChance = 0.2; // 공격형은 스피드 좋아함
        } else if (this.personality === BOT_PERSONALITIES.PLAYFUL) {
            if (this.hasItem === 'banana') useChance = 0.1; // 장난꾸러기는 바나나 설치
        }

        if (Math.random() < useChance) {
            handleItemEffect(this.id, this.hasItem);
            this.hasItem = null;
            // 봇은 클라이언트 UI 업데이트 불필요
        }
    }
}

// 봇 충돌 체크 (BOUNDING BOX)
function checkBotWallCollision(x, y) {
    // 플레이어 크기 (TILE_SIZE) 만큼 4지점 체크
    const points = [
        { c: Math.floor((x + 2) / TILE_SIZE), r: Math.floor((y + 2) / TILE_SIZE) }, // 좌상단 (+padding)
        { c: Math.floor((x + TILE_SIZE - 2) / TILE_SIZE), r: Math.floor((y + 2) / TILE_SIZE) }, // 우상단
        { c: Math.floor((x + 2) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - 2) / TILE_SIZE) }, // 좌하단
        { c: Math.floor((x + TILE_SIZE - 2) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - 2) / TILE_SIZE) } // 우하단
    ];

    for (const p of points) {
        if (p.r < 0 || p.r >= ROWS || p.c < 0 || p.c >= COLS) return true; // 맵 밖
        if (map[p.r][p.c] === 1) return true; // 벽
    }
    return false;
}
const TILE_SIZE = 32;

// --- 아이템 시스템 ---
let items = {};
let itemNextId = 1;
const ITEM_TYPES = ['speed', 'banana', 'shield'];

function spawnItem() {
    if (Object.keys(items).length >= 5) {
        // 가장 오래된 아이템(ID가 가장 작은 것) 삭제
        const oldestId = Object.keys(items).sort((a, b) => a - b)[0];
        delete items[oldestId];
    }

    const pos = getRandomSpawn();
    const id = itemNextId++;
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];

    items[id] = { x: pos.x, y: pos.y, type: type };
    io.emit('updateItems', items);
    console.log(`아이템 생성: ${type} at (${pos.x}, ${pos.y})`);
}

// 아이템 획득 판정 (범위 30으로 확대)
function checkItemCollection(playerId) {
    const player = players[playerId];
    if (!player) return;

    for (const itemId in items) {
        const item = items[itemId];
        const dx = player.x - item.x;
        const dy = player.y - item.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // 30px 이내 접근 시 획득 (판정 범위 완화)
        if (dist < 30) {
            if (player.hasItem) return; // Already has an item

            // 아이템 획득 시 기존 쉴드 해제
            if (player.hasShield) {
                player.hasShield = false;
                io.to(playerId).emit('itemEffect', { type: 'shield', on: false });
                io.emit('gameMessage', `[${player.nickname}] 님의 방어막이 새 아이템 획득으로 사라졌습니다.`);
            }

            player.hasItem = item.type;
            delete items[itemId]; // Remove from map

            io.emit('updateItems', items); // Update clients on item removal
            io.to(playerId).emit('updateInventory', player.hasItem); // Update player's inventory
            io.emit('gameMessage', `[${player.nickname}] 님이 [${item.type}] 획득!`);
            console.log(`아이템 획득: ${player.nickname} -> ${item.type}`);
            break;
        }
    }
}

// 15초마다 자동 생성
setInterval(() => {
    spawnItem();
    io.emit('gameMessage', `🎁 선물 상자가 나타났습니다!`);
}, 15000);

// 서버 시작 시 즉시 2개 생성 (테스트용)
setTimeout(() => {
    spawnItem(); spawnItem();
}, 1000);

// 봇 업데이트 루프 (약 10fps)
setInterval(() => {
    Object.keys(players).forEach(id => {
        if (players[id] instanceof Bot) {
            players[id].update();

            // 위치 동기화 및 상호작용 체크
            io.emit('playerMoved', players[id]);
            checkCollision(id);
            checkItemCollection(id);
            checkTrapCollision(id);
        }
    });
}, 100);

function createBot() {
    const botId = 'bot_' + Date.now();
    const bot = new Bot(botId);
    players[botId] = bot;

    io.emit('newPlayer', bot);
    io.emit('gameMessage', `🤖 [${bot.personality}] 성격의 봇이 입장했습니다!`);

    // 술래 없으면 참여
    if (!taggerId) {
        taggerId = botId;
        io.emit('updateTagger', taggerId);
        io.emit('gameMessage', `[${bot.nickname}] 님이 첫 술래입니다!`);
    }
}


// 맵 데이터
const ROWS = 15;
const COLS = 20;
const map = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
];

function getRandomSpawn() {
    let x, y, c, r;
    do {
        c = Math.floor(Math.random() * COLS);
        r = Math.floor(Math.random() * ROWS);
    } while (map[r][c] === 1);
    return { x: c * TILE_SIZE, y: r * TILE_SIZE };
}

io.on('connection', (socket) => {
    console.log('클라이언트 접속:', socket.id);
    setupSocketEvents(socket);
});

function setupSocketEvents(socket) {
    socket.on('joinGame', (data) => handleJoinGame(socket, data));
    socket.on('playerMove', (data) => handlePlayerMove(socket, data));
    socket.on('useItem', () => handleUseItem(socket));
    socket.on('disconnect', () => handleDisconnect(socket));
    socket.on('chatMessage', (msg) => handleChatMessage(socket, msg));
    socket.on('sendFeedback', (msg) => handleFeedback(socket, msg));
}

function handleFeedback(socket, msg) {
    if (!players[socket.id]) return;
    const nickname = players[socket.id].nickname;
    const logEntry = `[${new Date().toISOString()}] ${nickname}: ${msg}\n`;

    fs.appendFile('feedback.txt', logEntry, (err) => {
        if (err) console.error('Feedback save failed:', err);
        else console.log('Feedback saved:', logEntry.trim());
    });
}

function handleJoinGame(socket, data) {
    if (players[socket.id]) return;

    console.log('게임 입장:', data.nickname);

    const spawnPos = getRandomSpawn();
    players[socket.id] = {
        x: spawnPos.x,
        y: spawnPos.y,
        playerId: socket.id,
        color: data.color || '#e74c3c',
        nickname: data.nickname || '익명'
    };

    if (!taggerId) {
        taggerId = socket.id;
        io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 첫 술래입니다!`);
    } else {
        io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 입장했습니다.`);
    }

    socket.emit('joinSuccess', players[socket.id]);
    socket.emit('currentPlayers', players);
    socket.emit('updateItems', items); // 아이템 상태 전송
    socket.emit('updateTraps', traps); // 트랩 상태 전송
    socket.emit('updateTagger', taggerId);

    socket.broadcast.emit('newPlayer', players[socket.id]);
}

function handlePlayerMove(socket, movementData) {
    if (players[socket.id]) {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        io.emit('playerMoved', players[socket.id]);
        checkCollision(socket.id);
        checkItemCollection(socket.id);
        checkTrapCollision(socket.id); // 트랩 체크
    }
}

function handleUseItem(socket) {
    const player = players[socket.id];
    if (player && player.hasItem) {
        const itemType = player.hasItem;
        player.hasItem = null;
        io.to(socket.id).emit('updateInventory', null);
        handleItemEffect(socket.id, itemType);
    }
}

function handleDisconnect(socket) {
    if (players[socket.id]) {
        console.log('플레이어 퇴장:', players[socket.id].nickname);
        const leftNickname = players[socket.id].nickname;
        delete players[socket.id];
        io.emit('disconnectPlayer', socket.id);
        io.emit('gameMessage', `[${leftNickname}] 님이 나갔습니다.`);

        if (socket.id === taggerId) {
            const remainingIds = Object.keys(players);
            if (remainingIds.length > 0) {
                taggerId = remainingIds[Math.floor(Math.random() * remainingIds.length)];
                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `술래가 나가서 [${players[taggerId].nickname}] 님이 새 술래가 됩니다!`);
            } else {
                taggerId = null;
            }
        }
    }
}

function handleChatMessage(socket, msg) {
    if (players[socket.id]) {
        // 봇 소환 명령어
        if (msg.trim() === '/bot' || msg.trim() === '/addbot') {
            createBot();
            return;
        }

        const nickname = players[socket.id].nickname;
        io.emit('chatMessage', {
            nickname: nickname,
            message: msg,
            playerId: socket.id
        });
    }
}

// 충돌(태그) 판정 (쿨타임 적용)
let canTag = true;

// 트랩(바나나) 시스템
let traps = {};
let trapNextId = 1;

function handleItemEffect(playerId, itemType) {
    const player = players[playerId];
    if (!player) return; // Disconnect check inside effect

    io.emit('gameMessage', `[${player.nickname}] 님이 [${itemType}] 사용!`);

    if (itemType === 'speed') {
        player.isSpeeding = true;
        io.emit('playerMoved', player); // 상태 변경 알림 (속도 효과 보임)
        io.to(playerId).emit('itemEffect', { type: 'speed', duration: 5000 });

        // 5초 후 효과 해제 및 알림
        setTimeout(() => {
            if (players[playerId]) { // Check existence again
                players[playerId].isSpeeding = false;
                io.emit('playerMoved', players[playerId]);
            }
        }, 5000);

    } else if (itemType === 'shield') {
        player.hasShield = true;
        io.to(playerId).emit('itemEffect', { type: 'shield', on: true });
        io.emit('playerMoved', player); // 쉴드 킨 상태 알림
    } else if (itemType === 'banana') {
        const id = trapNextId++;
        traps[id] = {
            x: player.x,
            y: player.y,
            type: 'banana',
            ownerId: playerId, // 설치자 ID 저장
            createdAt: Date.now() // 생성 시간 저장
        };
        io.emit('updateTraps', traps);
        io.emit('gameMessage', `[${player.nickname}] 님이 바나나 함정을 설치했습니다! 🍌`);
    }
}

function checkTrapCollision(playerId) {
    const player = players[playerId];
    if (!player) return;

    for (const id in traps) {
        const trap = traps[id];

        // 설치자는 3초 동안 자신의 트랩에 걸리지 않음
        if (trap.ownerId === playerId && Date.now() - trap.createdAt < 3000) {
            continue;
        }

        const dx = player.x - trap.x;
        const dy = player.y - trap.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 20) { // 트랩 밟음
            delete traps[id];
            io.emit('updateTraps', traps);
            io.emit('gameMessage', `[${player.nickname}] 님이 바나나를 밟고 미끄러집니다! 으악!`);

            // 미끄러짐 효과 전송 (2초)
            if (players[playerId] instanceof Bot) {
                players[playerId].isSlipped = true;
                setTimeout(() => {
                    if (players[playerId]) players[playerId].isSlipped = false;
                }, 2000);
            } else {
                io.to(playerId).emit('playerSlipped', { duration: 2000 });
            }
            break;
        }
    }
}

function checkCollision(moverId) {
    if (!canTag) return;

    const ids = Object.keys(players);
    if (ids.length < 2) return;
    if (!taggerId || !players[taggerId]) return;

    const tagger = players[taggerId];

    for (const id of ids) {
        if (id !== taggerId) {
            const runner = players[id];
            const dx = tagger.x - runner.x;
            const dy = tagger.y - runner.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 25) {
                // 실드 체크
                if (runner.hasShield) {
                    runner.hasShield = false;
                    io.to(id).emit('itemEffect', { type: 'shield', on: false });
                    io.emit('gameMessage', `[${runner.nickname}] 님이 방어막으로 태그를 막았습니다!`);
                    canTag = false;
                    setTimeout(() => { canTag = true; }, 1000);
                    return;
                }

                // 태그 성공
                const oldTaggerId = taggerId;
                lastTaggerId = oldTaggerId; // 봇이 이 사람을 바로 쫓지 않게 설정
                setTimeout(() => { if (lastTaggerId === oldTaggerId) lastTaggerId = null; }, 5000);

                taggerId = id;
                io.emit('updateTagger', taggerId);
                io.emit('tagOccurred', { newTaggerId: taggerId });
                io.emit('gameMessage', `[${tagger.nickname}] -> [${runner.nickname}] 태그! (3초 무적)`);

                canTag = false;
                setTimeout(() => {
                    canTag = true;
                    io.emit('gameMessage', `술래 무적 해제!`);
                }, 3000);
                break;
            }
        }
    }
}
// 하단 중복 제거됨.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행: http://localhost:${PORT}`);
});
