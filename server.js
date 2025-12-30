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
// 맵 데이터 (game.js와 동일해야 함 - 추후 공유 파일로 분리 권장)
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
    } while (map[r][c] === 1); // 벽(1)이면 다시 뽑기

    return {
        x: c * TILE_SIZE,
        y: r * TILE_SIZE
    };
}

io.on('connection', (socket) => {
    console.log('클라이언트 접속:', socket.id);

    // 주의: 접속했다고 바로 플레이어를 생성하지 않음!
    // 'joinGame' 이벤트를 받아야 생성함.

    socket.on('joinGame', (data) => {
        // 이미 접속 중이면 무시
        if (players[socket.id]) return;

        console.log('게임 입장:', data.nickname);

        const spawnPos = getRandomSpawn();
        players[socket.id] = {
            x: spawnPos.x,
            y: spawnPos.y,
            playerId: socket.id,
            color: data.color || '#e74c3c', // 유저가 선택한 색상
            nickname: data.nickname || '익명' // 닉네임
        };

        // 술래가 없으면 이 사람이 술래
        if (!taggerId) {
            taggerId = socket.id;
            io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 첫 술래입니다!`);
        } else {
            io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 입장했습니다.`);
        }

        // 1. 나에게 현재 상태 전송 (입장 수락의 의미)
        socket.emit('joinSuccess', players[socket.id]);
        socket.emit('currentPlayers', players);
        socket.emit('updateTagger', taggerId);

        // 2. 다른 사람들에게 내 등장 알림
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
            console.log(`[채팅] ${nickname}: ${msg}`);
            // 모든 클라이언트에게 메시지 전송 (누가 보냈는지 포함)
            io.emit('chatMessage', {
                nickname: nickname,
                message: msg,
                playerId: socket.id
            });
        }
    });
});

// 충돌(태그) 판정 함수 (거리 기반)
function checkCollision(moverId) {
    const ids = Object.keys(players);
    if (ids.length < 2) return;
    if (!taggerId || !players[taggerId]) return;

    const tagger = players[taggerId];

    for (const id of ids) {
        if (id !== taggerId) {
            const runner = players[id];

            // 두 플레이어 중심 간의 거리 계산 (중심점은 x + TILE_SIZE/2, y + TILE_SIZE/2)
            // 그냥 좌상단 좌표 기준으로 거리 계산해도 무방함.
            // 32px (타일 크기) 보다 가까우면 닿은 것으로 판정

            const dx = tagger.x - runner.x;
            const dy = tagger.y - runner.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // 판정 범위: 25px (약간 겹쳐야 잡힘)
            if (distance < 25) {
                taggerId = id;
                io.emit('updateTagger', taggerId);
                io.emit('tagOccurred', { newTaggerId: taggerId });
                io.emit('gameMessage', `[${tagger.nickname}] -> [${runner.nickname}] 태그! 술래 변경!`);
                break;
            }
        }
    }
}

server.listen(3000, () => {
    console.log('서버가 3000번 포트에서 실행 중입니다: http://localhost:3000');
});
