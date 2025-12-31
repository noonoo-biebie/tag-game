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
    PLAYFUL: 'playful',       // 장난꾸러기: 랜덤 행동, 바나나 설치
    LAZY: 'lazy'              // 게으름: 가끔 멈춤, 아이템 잘 안 씀
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
        this.slipDir = { x: 0, y: 0 }; // 미끄러짐 방향

        // AI 제어 변수
        this.path = []; // 현재 이동 경로 (BFS)
        this.lastPathTime = 0; // 경로 계산 시간
        this.wanderTarget = null; // 배회 목표 지점
        this.moveDir = { x: 0, y: 0 };

        // [추가] 끼임 감지 (좌절 로직)
        this.lastCheckPos = { x: this.x, y: this.y };
        this.lastCheckTime = Date.now();
        this.isStuck = false; // 끼임 상태 플래그

        // [추가] 추격 기억 시스템 (Last Known Position)
        this.chaseMemory = null; // { x, y, id, timestamp }
    }

    getRandomColor() {
        const colors = ['#e67e22', '#1abc9c', '#9b59b6', '#e84393', '#f1c40f', '#3498db']; // 밝고 선명한 색상들
        return colors[Math.floor(Math.random() * colors.length)];
    }

    getRandomPersonality() {
        const allTypes = Object.values(BOT_PERSONALITIES);
        const currentCounts = {};
        allTypes.forEach(type => currentCounts[type] = 0);

        // 현재 존재하는 봇들의 성격 카운트
        for (const id in players) {
            if (players[id] instanceof Bot && players[id].personality) {
                currentCounts[players[id].personality]++;
            }
        }

        // 가장 적게 등장한 횟수 찾기
        let minCount = Infinity;
        for (const type of allTypes) {
            if (currentCounts[type] < minCount) {
                minCount = currentCounts[type];
            }
        }

        // 최소 등장 횟수인 성격들 중에서 랜덤 선택
        const candidates = allTypes.filter(type => currentCounts[type] === minCount);
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    update() {
        // [0] 기절 상태 체크
        if (this.stunnedUntil && Date.now() < this.stunnedUntil) return;

        // 1. 미끄러짐 처리 (속도 25, 10초 제한, 벽 충돌 시 정지)
        if (this.isSlipped) {
            // 10초 안전 장치
            if (Date.now() - this.slipStartTime > 10000) {
                this.isSlipped = false;
                return;
            }

            const slipSpeed = 25;
            let nextX = this.x + this.slipDir.x * slipSpeed;
            let nextY = this.y + this.slipDir.y * slipSpeed;

            // 맵 경계 체크
            if (nextX < 0) nextX = 0; else if (nextX > (COLS - 1) * TILE_SIZE) nextX = (COLS - 1) * TILE_SIZE;
            if (nextY < 0) nextY = 0; else if (nextY > (ROWS - 1) * TILE_SIZE) nextY = (ROWS - 1) * TILE_SIZE;

            // 벽 충돌 감지 강화 (모서리 끼임 방지)
            if (checkBotWallCollision(nextX, nextY)) {
                this.isSlipped = false;
            } else {
                // 이동 했으나, 위치 변화가 거의 없다면 (구석에 낌) 정지
                const distMoved = Math.hypot(this.x - nextX, this.y - nextY);
                if (distMoved < 0.1) {
                    this.isSlipped = false;
                } else {
                    this.x = nextX;
                    this.y = nextY;
                }
            }
            return;
        }

        // 2. 끼임 감지 (0.5초마다)
        if (Date.now() - this.lastCheckTime > 500) {
            const distMoved = Math.hypot(this.x - this.lastCheckPos.x, this.y - this.lastCheckPos.y);
            this.isStuck = (distMoved < 10);
            this.lastCheckPos = { x: this.x, y: this.y };
            this.lastCheckTime = Date.now();
        }

        // 3. AI 로직 (NO BFS, Direct Movement)
        if (taggerId === this.id) {
            // [술래]
            const visibleTarget = this.findBestTarget(); // 시야 내 타겟

            if (visibleTarget) {
                // [추격] 타겟 보임 -> 기억 갱신
                this.patrolTarget = null;
                this.chaseMemory = { x: visibleTarget.x, y: visibleTarget.y };

                // [수정] 끼임 감지 시 "좌우로 비비기" (Random Wiggle)
                // 사용자의 요청: "벽에 박고 있으면 좌우로 왔다갔다" -> 무작위 이동으로 탈출 유도
                if (this.isStuck) {
                    if (!this.wiggleTimer || Date.now() - this.wiggleTimer > 300) {
                        // 0.3초마다 랜덤 방향 전환
                        const angle = Math.random() * Math.PI * 2;
                        this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                        this.wiggleTimer = Date.now();
                    }
                    this.moveToDir();
                } else {
                    // [정상] 직선 추격
                    // this.wiggleTimer = 0; // 필요 시 리셋

                    const dx = visibleTarget.x - this.x;
                    const dy = visibleTarget.y - this.y;
                    const angle = Math.atan2(dy, dx);
                    this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };

                    // 성격별 거리 체크 등은 moveToDir 내부 속도나 외부 로직으로 처리됨.
                    // 단순하게 직진
                    this.moveToDir();
                }

            } else if (this.chaseMemory) {
                // [수색] 안 보임 -> 마지막 위치로 직진
                const dist = Math.hypot(this.chaseMemory.x - this.x, this.chaseMemory.y - this.y);

                if (dist < 40) {
                    // 도착했는데 없음 -> 기억 삭제 후 순찰 전환
                    this.chaseMemory = null;
                } else {
                    // 기억 장소로 이동
                    const dx = this.chaseMemory.x - this.x;
                    const dy = this.chaseMemory.y - this.y;
                    const angle = Math.atan2(dy, dx);
                    this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                    this.moveToDir();
                }

            } else {
                // [순찰] 기억도 없음 -> 랜덤 배회
                this.doPatrol();
            }

        } else {
            // [도망자]
            if (taggerId && players[taggerId]) {
                const tagger = players[taggerId];
                // 시야 내에 있고 250px 이내면 도망
                if (Math.hypot(tagger.x - this.x, tagger.y - this.y) < 250 &&
                    checkLineOfSight(this.x + 16, this.y + 16, tagger.x + 16, tagger.y + 16)) {

                    const dx = this.x - tagger.x;
                    const dy = this.y - tagger.y;
                    const angle = Math.atan2(dy, dx);
                    this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                    this.moveToDir();
                } else {
                    this.doPatrol();
                }
            } else {
                this.doPatrol();
            }
        }

        this.useItemLogic();
    }

    // [Helper] 단순 순찰 (랜덤 좌표로 직선 이동)
    doPatrol() {
        // 목표가 없거나, 너무 오래 걸리면(끼임) 리셋
        if (!this.patrolTarget || this.isStuck) {
            this.patrolTarget = getRandomSpawn();
            this.isStuck = false; // 타겟 바꿨으니 끼임 해제
        }

        const dist = Math.hypot(this.patrolTarget.x - this.x, this.patrolTarget.y - this.y);

        if (dist < 40) {
            // 도착 -> 다음 목표
            this.patrolTarget = null;
        } else {
            // 목표 방향으로 직진
            const dx = this.patrolTarget.x - this.x;
            const dy = this.patrolTarget.y - this.y;
            const angle = Math.atan2(dy, dx);
            this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            this.moveToDir();
        }
    }

    moveToDir() {
        const speed = this.isSpeeding ? 25 : 15;

        // X축 이동 시도
        let nextX = this.x + this.moveDir.x * speed;
        let hitX = false;

        if (nextX < 0) { nextX = 0; hitX = true; }
        if (nextX > (COLS - 1) * TILE_SIZE) { nextX = (COLS - 1) * TILE_SIZE; hitX = true; }

        if (checkBotWallCollision(nextX, this.y)) {
            hitX = true;
        } else {
            this.x = nextX;
        }

        // Y축 이동 시도
        let nextY = this.y + this.moveDir.y * speed;
        let hitY = false;

        if (nextY < 0) { nextY = 0; hitY = true; }
        if (nextY > (ROWS - 1) * TILE_SIZE) { nextY = (ROWS - 1) * TILE_SIZE; hitY = true; }

        if (checkBotWallCollision(this.x, nextY)) {
            hitY = true;
        } else {
            this.y = nextY;
        }

        // [끼임 방지] 양방향 막힘 시 랜덤 탈출
        if (hitX || hitY) {
            if (hitX && hitY && this.path.length === 0) {
                this.changeDirTime = 0;
                this.x -= this.moveDir.x * 5;
                this.y -= this.moveDir.y * 5;
                const angle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            } else {
                // 벽에 부딪혔을 때 약간의 랜덤성 추가하여 끼임 방지
                this.moveDir.x += (Math.random() - 0.5) * 0.2;
                this.moveDir.y += (Math.random() - 0.5) * 0.2;
                const mag = Math.sqrt(this.moveDir.x ** 2 + this.moveDir.y ** 2);
                if (mag > 0) { this.moveDir.x /= mag; this.moveDir.y /= mag; }
            }
        }
    }

    // 똑똑한 순찰(Patrol) 및 배회
    wander() {
        // 이미 경로가 있고 타겟이 유효하면 계속 이동
        if (this.path.length > 0) {
            const nextNode = this.path[0];
            const dx = nextNode.x - this.x;
            const dy = nextNode.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 20) {
                this.path.shift();
            } else {
                this.moveDir = { x: dx / dist, y: dy / dist };
                this.moveToDir();
            }
            return;
        }

        // 경로가 없으면(도착했거나 초기화됨) -> 새로운 무작위 순찰 지점 설정
        // 맵의 랜덤한 빈 공간을 목표로 삼고 BFS로 이동
        const target = getRandomSpawn(); // 랜덤 좌표 획득
        this.wanderTarget = target;

        // 경로 계산
        const newPath = findPath(this.x, this.y, target.x, target.y);
        if (newPath.length > 0) {
            this.path = newPath;
        } else {
            // 경로 생성 실패 시(완전 고립 등), 잠시 제자리 대기 후 재시도
            this.path = [];
            this.moveDir = { x: 0, y: 0 };
        }
    }

    findBestTarget() {
        let closest = null;
        let minDist = Infinity;
        for (const pid in players) {
            if (pid === this.id || pid === lastTaggerId) continue;
            const p = players[pid];
            const dist = Math.hypot(p.x - this.x, p.y - this.y);

            // [조건 추가] 시야에 보이는가? (벽 너머는 감지 불가)
            const isVisible = checkLineOfSight(this.x + 16, this.y + 16, p.x + 16, p.y + 16);

            if (dist < minDist && isVisible) {
                minDist = dist;
                closest = p;
            }
        }
        return closest;
    }

    useItemLogic() {
        if (!this.hasItem) return;
        let useChance = 0.05;

        // 공격형은 스피드 적극 사용
        if (this.personality === BOT_PERSONALITIES.AGGRESSIVE && this.hasItem === 'speed') {
            useChance = 0.2;
        }

        if (this.personality !== BOT_PERSONALITIES.LAZY && Math.random() < useChance) {
            handleItemEffect(this.id, this.hasItem);
            this.hasItem = null;
        }
    }



    useItemLogic() {
        if (!this.hasItem) return;

        // 성격별 사용 확률
        let useChance = 0.05; // 틱당 5%

        if (this.personality === BOT_PERSONALITIES.AGGRESSIVE) {
            if (this.hasItem === 'speed') useChance = 0.2; // 공격형은 스피드 좋아함
        } else if (this.personality === BOT_PERSONALITIES.PLAYFUL) {
            if (this.hasItem === 'banana') useChance = 0.1; // 장난꾸러기는 바나나 설치
        } else if (this.personality === BOT_PERSONALITIES.COWARD) {
            if (this.hasItem === 'shield' || this.hasItem === 'speed') useChance = 0.2; // 겁쟁이는 방어/도주템 즉시 사용
        }

        if (Math.random() < useChance) {
            handleItemEffect(this.id, this.hasItem);
            this.hasItem = null;
        }
    }
}

// BFS 경로 탐색 (Grid 기반)
function findPath(startX, startY, endX, endY) {
    const startC = Math.floor(startX / TILE_SIZE);
    const startR = Math.floor(startY / TILE_SIZE);
    const endC = Math.floor(endX / TILE_SIZE);
    const endR = Math.floor(endY / TILE_SIZE);

    if (startC === endC && startR === endR) return [];

    const queue = [{ c: startC, r: startR, path: [] }];
    const visited = new Set();
    visited.add(`${startC},${startR}`);

    // 최대 탐색 거리 제한
    let iter = 0;
    const MAX_ITER = 300;

    while (queue.length > 0) {
        if (iter++ > MAX_ITER) break;

        const { c, r, path } = queue.shift();

        if (c === endC && r === endR) {
            return path.map(p => ({ x: p.c * TILE_SIZE + TILE_SIZE / 2, y: p.r * TILE_SIZE + TILE_SIZE / 2 }));
        }

        const dirs = [
            { dc: 0, dr: -1 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 1, dr: 0 }
        ];

        for (const dir of dirs) {
            const nc = c + dir.dc;
            const nr = r + dir.dr;

            if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS &&
                map[nr][nc] === 0 && !visited.has(`${nc},${nr}`)) {

                visited.add(`${nc},${nr}`);
                queue.push({
                    c: nc, r: nr,
                    path: [...path, { c: nc, r: nr }]
                });
            }
        }
    }
    return [];
}
// BFS 경로 탐색 (Grid 기반)
function findPath(startX, startY, endX, endY) {
    const startC = Math.floor(startX / TILE_SIZE);
    const startR = Math.floor(startY / TILE_SIZE);
    const endC = Math.floor(endX / TILE_SIZE);
    const endR = Math.floor(endY / TILE_SIZE);

    if (startC === endC && startR === endR) return [];

    const queue = [{ c: startC, r: startR, path: [] }];
    const visited = new Set();
    visited.add(`${startC},${startR}`);

    // 최대 탐색 거리 제한
    let iter = 0;
    const MAX_ITER = 300;

    while (queue.length > 0) {
        if (iter++ > MAX_ITER) break;

        const { c, r, path } = queue.shift();

        if (c === endC && r === endR) {
            return path.map(p => ({ x: p.c * TILE_SIZE + TILE_SIZE / 2, y: p.r * TILE_SIZE + TILE_SIZE / 2 }));
        }

        const dirs = [
            { dc: 0, dr: -1 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 1, dr: 0 }
        ];

        for (const dir of dirs) {
            const nc = c + dir.dc;
            const nr = r + dir.dr;

            if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS &&
                map[nr][nc] === 0 && !visited.has(`${nc},${nr}`)) {

                visited.add(`${nc},${nr}`);
                queue.push({
                    c: nc, r: nr,
                    path: [...path, { c: nc, r: nr }]
                });
            }
        }
    }
    return [];
}

// BFS 경로 탐색 (Grid 기반)
function findPath(startX, startY, endX, endY) {
    const startC = Math.floor(startX / TILE_SIZE);
    const startR = Math.floor(startY / TILE_SIZE);
    const endC = Math.floor(endX / TILE_SIZE);
    const endR = Math.floor(endY / TILE_SIZE);

    if (startC === endC && startR === endR) return [];

    const queue = [{ c: startC, r: startR, path: [] }];
    const visited = new Set();
    visited.add(`${startC},${startR}`);

    // 최대 탐색 거리 제한 (너무 멀면 렉 방지)
    let iter = 0;
    const MAX_ITER = 300;

    while (queue.length > 0) {
        if (iter++ > MAX_ITER) break;

        const { c, r, path } = queue.shift();

        if (c === endC && r === endR) {
            return path.map(p => ({ x: p.c * TILE_SIZE + TILE_SIZE / 2, y: p.r * TILE_SIZE + TILE_SIZE / 2 }));
        }

        const dirs = [
            { dc: 0, dr: -1 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 1, dr: 0 }
        ];

        for (const dir of dirs) {
            const nc = c + dir.dc;
            const nr = r + dir.dr;

            if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS &&
                map[nr][nc] === 0 && !visited.has(`${nc},${nr}`)) {

                visited.add(`${nc},${nr}`);
                queue.push({
                    c: nc, r: nr,
                    path: [...path, { c: nc, r: nr }]
                });
            }
        }
    }
    return []; // 경로 없음
}

// 봇 충돌 체크 (BOUNDING BOX - 여유 공간 추가)
function checkBotWallCollision(x, y) {
    // 5px 여유를 두어 모서리 끼임 방지
    const margin = 5;
    const points = [
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 좌상단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 우상단
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) }, // 좌하단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) } // 우하단
    ];

    for (const p of points) {
        if (p.r < 0 || p.r >= ROWS || p.c < 0 || p.c >= COLS) return true; // 맵 밖
        if (map[p.r][p.c] === 1) return true; // 벽
    }
    return false;
}

// 두 점 사이의 시야 체크 (벽이 있는지) (Bresenham-like)
function checkLineOfSight(x1, y1, x2, y2) {
    // [개선] 4px 단위로 촘촘하게 검사 (벽 관통 방지)
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 4;
    const dx = (x2 - x1) / steps;
    const dy = (y2 - y1) / steps;

    let cx = x1;
    let cy = y1;

    for (let i = 0; i < steps; i++) {
        const c = Math.floor(cx / TILE_SIZE);
        const r = Math.floor(cy / TILE_SIZE);

        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
            if (map[r][c] === 1) return false; // 벽 막힘
        }

        cx += dx;
        cy += dy;
    }
    return true; // 뚫림
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
    // 공지용 액션
    socket.on('announceAction', (action) => handleAnnounceAction(socket, action));
}

function handleAnnounceAction(socket, action) {
    if (!players[socket.id]) return;
    const nickname = players[socket.id].nickname;
    const msg = `[${nickname}] 님이 ${action}`;
    io.emit('gameMessage', msg);
    io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' });
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
    // 0. 기절 상태 체크
    if (players[socket.id] && players[socket.id].stunnedUntil && Date.now() < players[socket.id].stunnedUntil) {
        return;
    }

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

// 리셋 확인용 변수
let resetRequestTime = 0;
let resetRequesterId = null;

function resetGame() {
    items = {};
    traps = {};
    io.emit('updateItems', items);
    io.emit('updateTraps', traps);

    // 플레이어/봇 재배치
    for (const id in players) {
        const p = players[id];
        const spawn = getRandomSpawn();
        p.x = spawn.x;
        p.y = spawn.y;
        p.targetX = p.x;
        p.targetY = p.y;
        p.isSlipped = false;
        p.stunnedUntil = 0;
        p.hasItem = null;
        p.hasShield = false;
        p.isSpeeding = false;
    }
    io.emit('currentPlayers', players);

    const msg = "🔄 맵이 초기화되었습니다!";
    io.emit('gameMessage', msg);
    io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' });
}

function handleChatMessage(socket, msg) {
    if (!players[socket.id]) return;

    const player = players[socket.id];
    const cmd = msg.trim();

    // 1. 봇 소환
    if (cmd === '/bot' || cmd === '/addbot') {
        createBot();
        const infoMsg = `[${player.nickname}] 님이 봇을 소환했습니다! 🤖`;
        io.emit('gameMessage', infoMsg);
        io.emit('chatMessage', { nickname: 'System', message: infoMsg, playerId: 'system' });
        return;
    }

    // 2. 봇 추방
    if (cmd === '/kickbot' || cmd === '/removebot') {
        // 봇 찾기 (뒤에서부터)
        let botId = null;
        const ids = Object.keys(players);
        for (let i = ids.length - 1; i >= 0; i--) {
            if (players[ids[i]] instanceof Bot) {
                botId = ids[i];
                break;
            }
        }

        if (botId) {
            delete players[botId];
            io.emit('disconnectPlayer', botId);
            const kickMsg = `[${player.nickname}] 님이 봇을 추방했습니다! 👋`;
            io.emit('gameMessage', kickMsg);
            io.emit('chatMessage', { nickname: 'System', message: kickMsg, playerId: 'system' });

            // 술래가 추방되었으면 새 술래 지정
            if (taggerId === botId) {
                const remaining = Object.keys(players);
                if (remaining.length > 0) {
                    taggerId = remaining[0];
                    io.emit('updateTagger', taggerId);
                    io.emit('tagOccurred', { newTaggerId: taggerId });
                } else {
                    taggerId = null;
                }
            }
        } else {
            const failMsg = "추방할 봇이 없습니다.";
            socket.emit('gameMessage', failMsg);
            socket.emit('chatMessage', { nickname: 'System', message: failMsg, playerId: 'system' });
        }
        return;
    }

    // 3. 리셋
    if (cmd === '/reset') {
        const now = Date.now();
        if (resetRequesterId === socket.id && now - resetRequestTime < 5000) {
            // 확정
            resetGame();
            const resetMsg = `[${player.nickname}] 님이 게임을 리셋했습니다! 💥`;
            io.emit('gameMessage', resetMsg);
            io.emit('chatMessage', { nickname: 'System', message: resetMsg, playerId: 'system' });
            resetRequesterId = null;
        } else {
            // 요청
            resetRequesterId = now;
            resetRequestTime = now;
            const warnMsg = "⚠️ 5초 안에 '/reset'을 한번 더 입력하면 초기화됩니다.";
            socket.emit('gameMessage', warnMsg);
            socket.emit('chatMessage', { nickname: 'System', message: warnMsg, playerId: 'system' });
        }
        return;
    }

    // 4. 도움말
    if (cmd === '/help' || cmd === '/명령어' || cmd === '/?') {
        const helpMsg = '<br>📜 <b>명령어 목록</b><br>' +
            '🤖 <b>/bot</b> : 봇 소환<br>' +
            '👋 <b>/kickbot</b> : 봇 추방<br>' +
            '🔄 <b>/reset</b> : 맵 초기화<br>' +
            '👁️ <b>/fog</b> : 시야 제한 해제 (치트)<br>' +
            '📝 <b>/피드백확인</b> : 수집된 피드백 보기';

        socket.emit('chatMessage', {
            nickname: 'System',
            message: helpMsg,
            playerId: 'system'
        });
        return;
    }

    // 5. 피드백 확인 (관리자용)
    if (cmd === '/readfeedback' || cmd === '/피드백확인') {
        fs.readFile('feedback.txt', 'utf8', (err, data) => {
            if (err) {
                socket.emit('chatMessage', {
                    nickname: 'System',
                    message: "아직 등록된 피드백이 없거나 파일을 읽을 수 없습니다.",
                    playerId: 'system'
                });
            } else {
                // HTML 줄바꿈 처리 및 최신순 정렬 (선택)
                // 너무 길 수 있으니 마지막 2000자만 끊거나, 일단 다 보여줌
                let formatted = data.trim().replace(/\n/g, '<br>');
                if (formatted === '') formatted = "피드백 내용이 비어있습니다.";

                socket.emit('chatMessage', {
                    nickname: 'System',
                    message: '<br>📢 <b>수집된 피드백 목록</b><br>' + formatted,
                    playerId: 'system'
                });
            }
        });
        return;
    }

    // 일반 메시지
    io.emit('chatMessage', {
        nickname: player.nickname,
        message: msg,
        playerId: socket.id
    });
}

// 충돌(태그) 판정

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
            // 미끄러짐 효과 전송 (벽까지 or 최대 10초)
            if (players[playerId] instanceof Bot) {
                const bot = players[playerId];
                bot.isSlipped = true;
                bot.slipStartTime = Date.now(); // [수정] 시작 시간 기록

                // 현재 이동 방향으로 미끄러짐
                bot.slipDir = { ...bot.moveDir };
                if (bot.slipDir.x === 0 && bot.slipDir.y === 0) {
                    bot.slipDir = { x: Math.random() < 0.5 ? 1 : -1, y: 0 };
                }
                // [수정] setTimeout 제거 -> update()에서 처리
            } else {
                // 플레이어에게 10초(넉넉히) 전송 -> 클라이언트가 벽 충돌 시 멈춤
                io.to(playerId).emit('playerSlipped', { duration: 10000 });
            }
            break;
        }
    }
}

function checkCollision(moverId) {
    // 쿨타임(canTag) 제거됨 -> 기절(Stun) 로직으로 대체

    const ids = Object.keys(players);
    if (ids.length < 2) return;
    if (!taggerId || !players[taggerId]) return;

    const tagger = players[taggerId];

    for (const id of ids) {
        if (id !== taggerId) {
            const runner = players[id];

            // [추가] 술래가 기절 상태면 태그 불가
            if (tagger.stunnedUntil && Date.now() < tagger.stunnedUntil) continue;

            const dx = tagger.x - runner.x;
            const dy = tagger.y - runner.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < 25) {
                // 실드 체크
                if (runner.hasShield) {
                    runner.hasShield = false;
                    io.to(id).emit('itemEffect', { type: 'shield', on: false });
                    io.emit('gameMessage', `[${runner.nickname}] 님이 방어막으로 태그를 막았습니다!`);

                    // 태그 실패 시 술래 잠깐 넉백/경직 (선택사항, 일단 유지)
                    tagger.stunnedUntil = Date.now() + 1000; // 1초 경직
                    return;
                }

                // 태그 성공
                const oldTaggerId = taggerId;
                lastTaggerId = oldTaggerId;
                setTimeout(() => { if (lastTaggerId === oldTaggerId) lastTaggerId = null; }, 5000);

                // 새 술래 지정
                taggerId = id;
                players[taggerId].stunnedUntil = Date.now() + 2000; // [수정] 2초 기절

                io.emit('updateTagger', taggerId);
                io.emit('tagOccurred', { newTaggerId: taggerId });
                io.emit('gameMessage', `[${tagger.nickname}] -> [${runner.nickname}] 태그! (새 술래 2초 기절)`);
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
