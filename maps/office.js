module.exports = {
    name: 'OFFICE',
    allowedSizes: ['L'],
    generate: function (rows = 60, cols = 60) {
        const map = Array.from({ length: rows }, () => Array(cols).fill(1));
        const rooms = [];

        class Node {
            constructor(r, c, w, h) {
                this.r = r; this.c = c; this.w = w; this.h = h;
                this.left = null; this.right = null;
                this.room = null;
            }
        }

        const MIN_SIZE = 8;

        function split(node) {
            if (node.left || node.right) return;

            let splitH = Math.random() < 0.5;
            if (node.w > node.h && node.w / node.h >= 1.25) splitH = false;
            else if (node.h > node.w && node.h / node.w >= 1.25) splitH = true;

            const max = (splitH ? node.h : node.w) - MIN_SIZE;
            if (max < MIN_SIZE) return;

            const splitSize = Math.floor(Math.random() * (max - MIN_SIZE + 1)) + MIN_SIZE;

            if (splitH) {
                node.left = new Node(node.r, node.c, node.w, splitSize);
                node.right = new Node(node.r + splitSize, node.c, node.w, node.h - splitSize);
            } else {
                node.left = new Node(node.r, node.c, splitSize, node.h);
                node.right = new Node(node.r, node.c + splitSize, node.h - splitSize, node.w - splitSize);
            }

            split(node.left);
            split(node.right);
        }

        const root = new Node(1, 1, rows - 2, cols - 2);
        split(root);

        function getCenter(node) {
            if (node.room) return { r: Math.floor(node.room.r + node.room.h / 2), c: Math.floor(node.room.c + node.room.w / 2) };
            if (node.left && node.right) {
                const l = getCenter(node.left);
                const r = getCenter(node.right);
                return Math.random() < 0.5 ? l : r;
            }
            return { r: Math.floor(node.r + node.h / 2), c: Math.floor(node.c + node.w / 2) };
        }

        function hTunnel(r, c1, c2) {
            const minC = Math.min(c1, c2);
            const maxC = Math.max(c1, c2);
            for (let c = minC; c <= maxC; c++) {
                if (c < 0 || c >= cols) continue;
                if (r >= 0 && r < rows) map[r][c] = 0;
                if (r + 1 >= 0 && r + 1 < rows) map[r + 1][c] = 0;
            }
        }

        function vTunnel(c, r1, r2) {
            const minR = Math.min(r1, r2);
            const maxR = Math.max(r1, r2);
            for (let r = minR; r <= maxR; r++) {
                if (r < 0 || r >= rows) continue;
                if (c >= 0 && c < cols) map[r][c] = 0;
                if (c + 1 >= 0 && c + 1 < cols) map[r][c + 1] = 0;
            }
        }

        function createCorridor(p1, p2) {
            if (Math.random() < 0.5) {
                hTunnel(p1.r, p1.c, p2.c);
                vTunnel(p2.c, p1.r, p2.r);
            } else {
                vTunnel(p1.c, p1.r, p2.r);
                hTunnel(p2.r, p1.c, p2.c);
            }
        }

        function addPillars(r, c, w, h) {
            const gap = 3;
            for (let i = 2; i < h - 2; i += gap) {
                const rowIndex = r + i;
                if (!map[rowIndex]) continue;
                for (let j = 2; j < w - 2; j += gap) {
                    const colIndex = c + j;
                    if (colIndex >= 0 && colIndex < cols) map[rowIndex][colIndex] = 1;
                }
            }
        }

        function processNode(node) {
            if (node.left || node.right) {
                if (node.left) processNode(node.left);
                if (node.right) processNode(node.right);
                if (node.left && node.right) {
                    createCorridor(getCenter(node.left), getCenter(node.right));
                }
            } else {
                const padding = 1;
                const roomW = Math.max(4, node.w - padding * 2);
                const roomH = Math.max(4, node.h - padding * 2);
                const roomR = node.r + padding;
                const roomC = node.c + padding;

                node.room = { r: roomR, c: roomC, w: roomW, h: roomH };
                rooms.push(node.room);
                for (let r = roomR; r < roomR + roomH; r++) {
                    if (!map[r]) continue;
                    for (let c = roomC; c < roomC + roomW; c++) {
                        if (c >= 0 && c < cols) map[r][c] = 0;
                    }
                }
                if (roomW >= 10 && roomH >= 10 && Math.random() < 0.3) {
                    addPillars(roomR, roomC, roomW, roomH);
                }
            }
        }

        processNode(root);

        const extraConnections = Math.floor(rooms.length * 0.5);
        for (let i = 0; i < extraConnections; i++) {
            const roomA = rooms[Math.floor(Math.random() * rooms.length)];
            let bestDist = Infinity;
            let roomB = null;
            const centerA = { r: roomA.r + roomA.h / 2, c: roomA.c + roomA.w / 2 };

            for (const other of rooms) {
                if (other === roomA) continue;
                const centerB = { r: other.r + other.h / 2, c: other.c + other.w / 2 };
                const dist = Math.abs(centerA.r - centerB.r) + Math.abs(centerA.c - centerB.c);
                if (dist < bestDist) {
                    bestDist = dist;
                    roomB = other;
                }
            }

            if (roomB) {
                const centerB = { r: Math.floor(roomB.r + roomB.h / 2), c: Math.floor(roomB.c + roomB.w / 2) };
                const centerA_Int = { r: Math.floor(centerA.r), c: Math.floor(centerA.c) };
                createCorridor(centerA_Int, centerB);
            }
        }

        return map;
    }
};
