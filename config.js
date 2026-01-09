// [Config.js] Shared Configuration
const TILE_SIZE = 32;
// Default Rows/Cols (deprecated by dynamic map sizing but kept for compatibility)
const ROWS = 15;
const COLS = 20;

// AI 봇 성격 정의
const BOT_PERSONALITIES = {
    AGGRESSIVE: 'aggressive', // 공격형: 끈질긴 추격, 아이템 즉시 사용
    CAREFUL: 'careful',       // 신중형: 도주 우선, 쉴드 선호
    PLAYFUL: 'playful',       // 장난꾸러기: 랜덤 행동, 바나나 설치
    COWARD: 'coward'          // 겁쟁이: 사람이 보이면 무조건 도망
};

const ITEM_TYPES = ['speed', 'banana', 'shield'];

const TILE_IDS = {
    EMPTY: 0,
    WALL: 1,
    MUD: 2,
    ICE: 3,
    LAVA: 4
};

const COLORS = {
    TAGGER: '#ff4444',     // 술래 (빨강)
    RUNNER: '#4444ff',     // 도망자 (파랑) - 기본값 (사용자 커스텀 가능)
    BOT: '#888888',        // 봇 (회색) - 기본값
    ZOMBIE: '#2ecc71',     // 좀비 (녹색)
    WALL: '#34495e',       // 벽 (짙은 남색)
    MUD: '#795548',        // 진흙 (갈색)
    ICE: '#aaddff',        // 얼음 (하늘색)
    LAVA: '#e74c3c'        // 용암 (붉은색)
};

// Physics Constants
const PLAYER_SPEED = 4;
const SERVER_TICK_RATE = 20; // 50ms (20 FPS)
const WS_TICK_RATE = 15; // 66ms (15 FPS) - Client Update Rate
const ITEM_SPAWN_INTERVAL = 5000; // 5초

const PORT = (typeof process !== 'undefined' && process.env) ? (process.env.PORT || 3000) : 3000;

// [New] Map Standardization Sizes
const MAP_SIZES = {
    S: { width: 20, height: 15 },
    M: { width: 40, height: 30 },
    L: { width: 60, height: 60 },
    M_SQUARE: { width: 40, height: 40 },
    L_RECT: { width: 60, height: 45 }
};

// [New] Target Population for Voting Recommendations
const TARGET_POPULATION = {
    S: { TAG: 4, ZOMBIE: 8, BOMB: 6, ICE: 6 },
    M: { TAG: 10, ZOMBIE: 16, BOMB: 10, ICE: 12 },
    L: { TAG: 20, ZOMBIE: 32, BOMB: 16, ICE: 20 }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PORT,
        ROWS,
        COLS,
        TILE_SIZE,
        TILE_IDS,
        ITEM_TYPES,
        COLORS,
        PLAYER_SPEED,
        SERVER_TICK_RATE,
        WS_TICK_RATE,
        ITEM_SPAWN_INTERVAL,
        MAP_SIZES,
        BOT_PERSONALITIES,
        TARGET_POPULATION
    };
} else {
    // Browser global
    window.TILE_SIZE = TILE_SIZE;
    window.MAP_SIZES = MAP_SIZES;
    window.TILE_IDS = TILE_IDS;
    window.COLORS = COLORS;
    window.PLAYER_SPEED = PLAYER_SPEED;
    window.ROWS = ROWS;
    window.COLS = COLS;
    window.BOT_PERSONALITIES = BOT_PERSONALITIES;
    window.ITEM_TYPES = ITEM_TYPES;
    window.TARGET_POPULATION = TARGET_POPULATION;
}
