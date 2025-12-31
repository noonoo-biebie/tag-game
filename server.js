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
            io.to(playerId).emit('playerSlipped', { duration: 2000 });
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
