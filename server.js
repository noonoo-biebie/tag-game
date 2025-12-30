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
let taggerId = null; // 현재 술래의 ID

// 기본 타일 크기 (충돌 판정용)
const TILE_SIZE = 32;

io.on('connection', (socket) => {
    console.log('플레이어 접속:', socket.id);

    // 새 플레이어 정보 생성
    players[socket.id] = {
        x: Math.floor(Math.random() * 10) * TILE_SIZE + TILE_SIZE, // 랜덤 시작 위치
        y: Math.floor(Math.random() * 10) * TILE_SIZE + TILE_SIZE,
        playerId: socket.id,
        // 랜덤 파스텔톤 색상
        color: `hsl(${Math.random() * 360}, 70%, 60%)`
    };

    // 술래가 없으면 이 사람이 술래
    if (!taggerId) {
        taggerId = socket.id;
        io.emit('gameMessage', '새로운 술래가 지정되었습니다!');
    }

    // 접속한 전원에게 현재 상황 전송
    io.emit('currentPlayers', players);
    io.emit('updateTagger', taggerId);

    // 플레이어 이동
    socket.on('playerMove', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;

            // 모든 클라이언트에게 이동 알림
            io.emit('playerMoved', players[socket.id]);

            // 충돌 감지 로직 (서버 권한 타일 기반 판정)
            checkCollision(socket.id);
        }
    });

    socket.on('disconnect', () => {
        console.log('플레이어 접속 해제:', socket.id);
        delete players[socket.id];
        io.emit('disconnectPlayer', socket.id);

        // 만약 술래가 나갔다면
        if (socket.id === taggerId) {
            const remainingIds = Object.keys(players);
            if (remainingIds.length > 0) {
                // 남은 사람 중 랜덤으로 술래 지정
                taggerId = remainingIds[Math.floor(Math.random() * remainingIds.length)];
                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', '술래가 나갔습니다. 새 술래가 지정됩니다!');
            } else {
                taggerId = null;
            }
        }
    });
});

// 충돌(태그) 판정 함수
function checkCollision(moverId) {
    // 플레이어가 2명 미만이면 잡기 로직 필요 없음
    const ids = Object.keys(players);
    if (ids.length < 2) return;

    // 움직인 사람이 술래라면 -> 일반인을 잡았는지 체크
    // 움직인 사람이 일반인인데 -> 술래에게 들이박았는지(자살) 체크

    // 간단하게: 술래와 다른 누군가 겹쳤는지 확인
    if (!taggerId || !players[taggerId]) return;

    const tagger = players[taggerId];

    for (const id of ids) {
        if (id !== taggerId) {
            const runner = players[id];
            // 같은 칸에 있으면 잡힌 것으로 간주 (정확히 좌표가 같을 때)
            if (tagger.x === runner.x && tagger.y === runner.y) {
                // 태그 발생! 술래 교체
                taggerId = id; // 잡힌 사람이 새 술래

                io.emit('updateTagger', taggerId);
                io.emit('tagOccurred', { newTaggerId: taggerId });
                io.emit('gameMessage', '잡혔습니다! 술래가 바뀝니다!');
                break; // 한 번에 한 명만 잡음
            }
        }
    }
}

server.listen(3000, () => {
    console.log('서버가 3000번 포트에서 실행 중입니다: http://localhost:3000');
});
