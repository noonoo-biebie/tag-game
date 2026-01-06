const fs = require('fs');
const path = require('path');

function loadMaps() {
    const maps = {};
    const mapsDir = path.join(__dirname, 'maps');

    if (!fs.existsSync(mapsDir)) {
        console.error("[MapLoader] 'maps' directory not found!");
        return maps;
    }

    const files = fs.readdirSync(mapsDir);

    files.forEach(file => {
        if (file.endsWith('.js')) {
            try {
                const mapPath = path.join(mapsDir, file);
                // 캐시 삭제 (동적 리로드 대비)
                delete require.cache[require.resolve(mapPath)];

                const mapModule = require(mapPath);

                // 유효성 검사: 이름과 데이터(또는 생성함수)가 있어야 함
                // mapModule.name: 맵 식별자 (영어, 대문자 권장)
                // mapModule.data: 2차원 배열 (정적 맵)
                // mapModule.generate: 생성 함수 (동적 맵)

                if (mapModule.name && (mapModule.data || mapModule.generate)) {
                    maps[mapModule.name] = mapModule;
                    console.log(`[MapLoader] Loaded map: ${mapModule.name}`);
                } else {
                    console.warn(`[MapLoader] Skipped invalid map file: ${file} (Missing name or data/generate)`);
                }
            } catch (err) {
                console.error(`[MapLoader] Error loading map file: ${file}`, err);
            }
        }
    });

    return maps;
}

module.exports = { loadMaps };
