const { ROWS, COLS, TILE_SIZE, BOT_PERSONALITIES } = require('./config');
const { getRandomSpawn, checkBotWallCollision, checkLineOfSight, findPath } = require('./utils');

class Bot {
    constructor(id, mapData) {
        this.id = id;
        this.playerId = id; // 클라이언트 호환성
        this.nickname = '🤖Bot_' + id.slice(0, 4);
        this.color = this.getRandomColor();
        this.personality = this.getRandomPersonality();

        const spawn = getRandomSpawn(mapData);
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

        // 기절 관련
        this.stunnedUntil = 0;

        // AI 제어 변수
        this.path = []; // 현재 이동 경로 (BFS)
        this.lastPathTime = 0; // 경로 계산 시간
        this.wanderTarget = null; // 배회 목표 지점
        this.moveDir = { x: 0, y: 0 };

        // 끼임 감지 (좌절 로직)
        this.lastCheckPos = { x: this.x, y: this.y };
        this.lastCheckTime = Date.now();
        this.isStuck = false; // 끼임 상태 플래그

        // 추격 기억 시스템 (Last Known Position)
        this.chaseMemory = null; // { x, y, id, timestamp }

        // 도망 상태 (Hysteresis)
        this.isFleeing = false;

        // 비비기 타이머
        this.wiggleTimer = 0;

        // [공포 시스템] 지속적인 도망을 위한 변수
        this.fearTimer = 0;
        this.lastFleeAngle = 0;
    }

    getRandomColor() {
        const colors = ['#e67e22', '#1abc9c', '#9b59b6', '#e84393', '#f1c40f', '#3498db'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    getRandomPersonality(existingPlayers = {}) {
        const allTypes = Object.values(BOT_PERSONALITIES);
        const currentCounts = {};
        allTypes.forEach(type => currentCounts[type] = 0);

        // 현재 존재하는 봇들의 성격 카운트
        for (const id in existingPlayers) {
            if (existingPlayers[id] instanceof Bot && existingPlayers[id].personality) {
                currentCounts[existingPlayers[id].personality]++;
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

    // 메인 업데이트 루프
    update(players, taggerId, lastTaggerId, callbacks, mapData, gameMode = 'TAG') {
        // [0] 기절 상태 체크
        if (this.stunnedUntil && Date.now() < this.stunnedUntil) return;

        // 1. 미끄러짐 처리
        if (this.isSlipped) {
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

            if (checkBotWallCollision(nextX, nextY, mapData)) {
                this.isSlipped = false;
            } else {
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

        // 3. AI 로직
        let isChaser = false;
        if (gameMode === 'ZOMBIE') {
            isChaser = this.isZombie;
        } else {
            isChaser = (taggerId === this.id);
        }

        let target = null;
        let canSee = false;

        // 1. 타겟(적 또는 먹잇감) 탐색
        if (isChaser) {
            // 추격자: 보이는 가장 가까운 대상을 찾음
            target = this.findBestTarget(players, lastTaggerId, mapData, gameMode);
            if (target) canSee = true;
        } else {
            // 도망자: 가장 가까운 위협 요소를 찾음 (시야 체크 전)
            let distToThreat = Infinity;
            if (gameMode === 'ZOMBIE') {
                for (const pid in players) {
                    if (pid === this.id) continue;
                    if (players[pid].isZombie) {
                        const d = Math.hypot(players[pid].x - this.x, players[pid].y - this.y);
                        if (d < distToThreat) {
                            distToThreat = d;
                            target = players[pid]; // 잠정적 타겟
                        }
                    }
                }
            } else {
                if (taggerId && players[taggerId]) {
                    target = players[taggerId];
                    distToThreat = Math.hypot(target.x - this.x, target.y - this.y);
                }
            }

            // 도망자 시야 체크 (250px)
            if (target && distToThreat < 250) {
                if (checkLineOfSight(this.x + 16, this.y + 16, target.x + 16, target.y + 16, mapData)) {
                    canSee = true;
                }
            }
        }

        // 2. 행동 결정
        if (canSee) {
            if (isChaser) {
                // [추격자] 발견 -> 추격 및 위치 기억
                this.patrolTarget = null;
                this.chaseMemory = { x: target.x, y: target.y };
                const angle = Math.atan2(target.y - this.y, target.x - this.x);
                this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                this.moveToDir(mapData);
            } else {
                // [도망자] 발견 -> 공포 및 도주
                this.fearTimer = Date.now() + 2500;
                this.lastFleeAngle = Math.atan2(this.y - target.y, this.x - target.x);
                this.moveDir = { x: Math.cos(this.lastFleeAngle), y: Math.sin(this.lastFleeAngle) };

                // 패닉 무빙
                if (this.isStuck) {
                    const panicAngle = Math.random() * Math.PI * 2;
                    this.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
                    this.lastFleeAngle = panicAngle;
                }
                this.moveToDir(mapData);
            }
        } else {
            // 안 보일 때 (기억 또는 공포 의존)
            if (isChaser && this.chaseMemory) {
                // [추격자] 기억된 위치로 이동
                if (this.isStuck) {
                    // 벽 막힘 탈출
                    if (!this.wiggleTimer || Date.now() - this.wiggleTimer > 300) {
                        const wiggleAngle = Math.random() * Math.PI * 2;
                        this.moveDir = { x: Math.cos(wiggleAngle), y: Math.sin(wiggleAngle) };
                        this.wiggleTimer = Date.now();
                    }
                    this.moveToDir(mapData);
                    return;
                }

                const dx = this.chaseMemory.x - this.x;
                const dy = this.chaseMemory.y - this.y;

                if (Math.hypot(dx, dy) < 32) {
                    // 도착 후 수색
                    if (!this.searchTimer) this.searchTimer = Date.now() + 2000;

                    if (Date.now() < this.searchTimer) {
                        if (Math.random() < 0.1) {
                            const searchAngle = Math.random() * Math.PI * 2;
                            this.moveDir = { x: Math.cos(searchAngle), y: Math.sin(searchAngle) };
                        }
                        this.moveToDir(mapData);
                        return;
                    } else {
                        // 수색 종료
                        this.chaseMemory = null;
                        this.searchTimer = 0;
                        this.doPatrol(mapData);
                    }
                } else {
                    const angle = Math.atan2(dy, dx);
                    this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                    this.moveToDir(mapData);
                }
            } else if (!isChaser && Date.now() < this.fearTimer) {
                // [도망자] 공포 상태 유지 (계속 도망)
                this.isFleeing = true;
                this.moveDir = { x: Math.cos(this.lastFleeAngle), y: Math.sin(this.lastFleeAngle) };
                if (this.isStuck) {
                    const panicAngle = Math.random() * Math.PI * 2;
                    this.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
                    this.lastFleeAngle = panicAngle;
                }
                this.moveToDir(mapData);
            } else {
                // [공통] 평소 상태 -> 순찰
                this.isFleeing = false;
                this.doPatrol(mapData);
            }
        }


        this.useItemLogic(callbacks.handleItemEffect);
    }

    doPatrol(mapData) {
        if (!this.patrolTarget || this.isStuck) {
            this.patrolTarget = getRandomSpawn(mapData);
            this.isStuck = false;
        }

        const dist = Math.hypot(this.patrolTarget.x - this.x, this.patrolTarget.y - this.y);

        if (dist < 40) {
            this.patrolTarget = null;
        } else {
            const dx = this.patrolTarget.x - this.x;
            const dy = this.patrolTarget.y - this.y;
            const angle = Math.atan2(dy, dx);
            this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            this.moveToDir(mapData);
        }
    }

    moveToDir(mapData) {
        const speed = this.isSpeeding ? 25 : 15;

        // X축
        let nextX = this.x + this.moveDir.x * speed;
        let hitX = false;
        const mapRows = mapData.length;
        const mapCols = mapData[0].length;

        if (nextX < 0) { nextX = 0; hitX = true; }
        if (nextX > (mapCols - 1) * TILE_SIZE) { nextX = (mapCols - 1) * TILE_SIZE; hitX = true; }
        if (checkBotWallCollision(nextX, this.y, mapData)) hitX = true;
        else this.x = nextX;

        // Y축
        let nextY = this.y + this.moveDir.y * speed;
        let hitY = false;
        if (nextY < 0) { nextY = 0; hitY = true; }
        if (nextY > (mapRows - 1) * TILE_SIZE) { nextY = (mapRows - 1) * TILE_SIZE; hitY = true; }
        if (checkBotWallCollision(this.x, nextY, mapData)) hitY = true;
        else this.y = nextY;

        // 양방향 막힘 시 랜덤 탈출 (끼임 방지)
        if (hitX || hitY) {
            if (hitX && hitY && this.path.length === 0) {
                this.x -= this.moveDir.x * 5;
                this.y -= this.moveDir.y * 5;
                const angle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            } else {
                this.moveDir.x += (Math.random() - 0.5) * 0.2;
                this.moveDir.y += (Math.random() - 0.5) * 0.2;
                const mag = Math.sqrt(this.moveDir.x ** 2 + this.moveDir.y ** 2);
                if (mag > 0) { this.moveDir.x /= mag; this.moveDir.y /= mag; }
            }
        }
    }

    // [Legacy] Wander using BFS (Used if needed, currently mainly using doPatrol)
    wander(mapData) {
        if (this.path.length > 0) {
            const nextNode = this.path[0];
            const dx = nextNode.x - this.x;
            const dy = nextNode.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 20) {
                this.path.shift();
            } else {
                this.moveDir = { x: dx / dist, y: dy / dist };
                this.moveToDir(mapData);
            }
            return;
        }

        const target = getRandomSpawn(mapData);
        this.wanderTarget = target;
        const newPath = findPath(this.x, this.y, target.x, target.y, mapData);
        if (newPath.length > 0) {
            this.path = newPath;
        } else {
            this.path = [];
            this.moveDir = { x: 0, y: 0 };
        }
    }

    findBestTarget(players, lastTaggerId, mapData, gameMode = 'TAG') {
        let closest = null;
        let minDist = Infinity;
        for (const pid in players) {
            if (pid === this.id) continue;
            const p = players[pid];

            // 타겟 필터링
            if (gameMode === 'ZOMBIE') {
                // 좀비는 생존자(비좀비)만 추격
                if (p.isZombie) continue;
            } else {
                // 기본 술래잡기: 기절한 사람 제외
                if (p.stunnedUntil && Date.now() < p.stunnedUntil) continue;
            }

            const dist = Math.hypot(p.x - this.x, p.y - this.y);

            // 시야 체크
            const isVisible = checkLineOfSight(this.x + 16, this.y + 16, p.x + 16, p.y + 16, mapData);

            if (dist < minDist && isVisible) {
                minDist = dist;
                closest = p;
            }
        }
        return closest;
    }

    useItemLogic(handleItemEffectCallback) {
        if (!this.hasItem) return;
        let useChance = 0.05;

        if (this.personality === BOT_PERSONALITIES.AGGRESSIVE) {
            if (this.hasItem === 'speed') useChance = 0.2;
        } else if (this.personality === BOT_PERSONALITIES.PLAYFUL) {
            if (this.hasItem === 'banana') useChance = 0.1;
        } else if (this.personality === BOT_PERSONALITIES.COWARD) {
            if (this.hasItem === 'shield' || this.hasItem === 'speed') useChance = 0.2;
        }

        if (Math.random() < useChance) {
            if (handleItemEffectCallback) {
                handleItemEffectCallback(this.id, this.hasItem);
            }
            this.hasItem = null;
        }
    }
}

module.exports = Bot;
