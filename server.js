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

// 접속한 플레이어들을 관리하는 객체
let players = {};

io.on('connection', (socket) => {
    console.log('플레이어 접속:', socket.id);

    // 새 플레이어 생성
    players[socket.id] = {
        x: 64, // 초기 위치 (2*32)
        y: 64,
        playerId: socket.id,
        color: '#' + Math.floor(Math.random() * 16777215).toString(16) // 랜덤 색상
    };

    // 현재 접속한 모든 플레이어 정보 전송
    io.emit('currentPlayers', players);

    // 플레이어 이동 수신
    socket.on('playerMove', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;

            // 변경된 정보 브로드캐스트 (모든 사람에게 알림)
            io.emit('playerMoved', players[socket.id]);
        }
    });

    socket.on('disconnect', () => {
        console.log('플레이어 접속 해제:', socket.id);
        delete players[socket.id];
        io.emit('disconnectPlayer', socket.id);
    });
});

server.listen(3000, () => {
    console.log('서버가 3000번 포트에서 실행 중입니다: http://localhost:3000');
});
