const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

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
    if (Object.keys(items).length >= 5) return;

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
            if (player.hasItem) return;

            player.hasItem = item.type;
            delete items[itemId];

            io.emit('updateItems', items);
            io.to(playerId).emit('updateInventory', player.hasItem);
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

    socket.on('joinGame', (data) => {
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
        socket.emit('updateTagger', taggerId);

        socket.broadcast.emit('newPlayer', players[socket.id]);
    });

    socket.on('playerMove', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            io.emit('playerMoved', players[socket.id]);
            checkCollision(socket.id);
            checkItemCollection(socket.id);
        }
    });

    socket.on('useItem', () => {
        const player = players[socket.id];
        if (player && player.hasItem) {
            const itemType = player.hasItem;
            player.hasItem = null;
            io.to(socket.id).emit('updateInventory', null);
            handleItemEffect(socket.id, itemType);
        }
    });

    socket.on('disconnect', () => {
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
    });

    socket.on('chatMessage', (msg) => {
        if (players[socket.id]) {
            const nickname = players[socket.id].nickname;
            io.emit('chatMessage', {
                nickname: nickname,
                message: msg,
                playerId: socket.id
            });
        }
    });
});

// 충돌(태그) 판정 (쿨타임 적용)
let canTag = true;

function handleItemEffect(playerId, itemType) {
    const player = players[playerId];
    io.emit('gameMessage', `[${player.nickname}] 님이 [${itemType}] 사용!`);

    if (itemType === 'speed') {
        io.to(playerId).emit('itemEffect', { type: 'speed', duration: 5000 });
    } else if (itemType === 'shield') {
        player.hasShield = true;
        io.to(playerId).emit('itemEffect', { type: 'shield', on: true });
        // 방어막은 시간 제한 없이 태그 당할 때까지 유지 (혹은 시간 제한 둘 수도 있음)
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
