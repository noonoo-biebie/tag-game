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
        socket.emit('updateTagger', taggerId);

        socket.broadcast.emit('newPlayer', players[socket.id]);
    });

    socket.on('playerMove', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            io.emit('playerMoved', players[socket.id]);
            checkCollision(socket.id);
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

server.listen(3000, () => {
    console.log('서버 실행: http://localhost:3000');
});
