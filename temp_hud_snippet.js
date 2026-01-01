
function drawHUD() {
    if (!isJoined) return;

    // 생존자 수 계산
    let survivors = 0;
    let zombies = 0;
    Object.values(players).forEach(p => {
        if (p.isZombie) zombies++;
        else survivors++;
    });

    const padding = 10;
    const boxWidth = 200;
    const boxHeight = 80;
    const x = canvas.width - boxWidth - padding;
    const y = padding;

    // 반투명 배경
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ctx.strokeRect(x, y, boxWidth, boxHeight);

    // 텍스트
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px "Noto Sans KR", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const textX = x + 15;
    const textY = y + 15;

    ctx.fillText(`👥 생존자: ${survivors}명`, textX, textY);
    ctx.fillStyle = '#2ecc71'; // 좀비 색상
    ctx.fillText(`🧟 좀비: ${zombies}마리`, textX, textY + 30);
}
