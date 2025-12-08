// api/start-game.js - V0.7.1 (修复：彻底清空 flags 防止连胜继承)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

// 完整的角色列表 (15个)
const ROLES = [
    '技能观测者', '利他守护者', '投票阻断者', '沉默制裁者',
    '同盟者', '减票守护者', '双票使者', '平票终结者',
    '影子胜者', '集票胜者', '三人王者', '免票胜者',
    '平票赢家', '普通玩家', '普通玩家' 
    // 如果人数多于角色数，剩下的都是普通玩家
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    const { roomCode } = req.body;
    
    // 1. 获取房间内玩家
    const { data: players, error } = await supabase.from('players').select('*').eq('room_code', roomCode);
    
    if (error || !players || players.length < 2) {
        return res.status(400).json({ message: '无法开始游戏：人数不足或房间错误' });
    }

    // 2. 随机洗牌算法 (Fisher-Yates)
    const shuffledRoles = [...ROLES];
    // 根据人数扩展角色池 (如果人多，补平民)
    while (shuffledRoles.length < players.length) {
        shuffledRoles.push('普通玩家');
    }
    // 打乱数组
    for (let i = shuffledRoles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRoles[i], shuffledRoles[j]] = [shuffledRoles[j], shuffledRoles[i]];
    }

    // 3. 分配角色并重置状态
    const updates = players.map((player, index) => ({
        id: player.id,
        room_code: roomCode,
        name: player.name, // 必须带上，否则可能会报错
        role: shuffledRoles[index],
        is_alive: true,
        // 【关键修复】必须重置为空对象，防止"连续平票"等计数器带入下一局
        flags: {} 
    }));

    // 4. 更新数据库
    
    // 4.1 更新玩家表
    const { error: updateError } = await supabase.from('players').upsert(updates);
    if (updateError) return res.status(500).json({ message: '分发角色失败', error: updateError.message });

    // 4.2 清空旧数据 (投票记录、行动记录、日志)
    await supabase.from('votes').delete().eq('room_code', roomCode);
    await supabase.from('night_actions').delete().eq('room_code', roomCode);
    await supabase.from('game_logs').delete().eq('room_code', roomCode);

    // 4.3 更新房间状态 -> 进入第一夜
    await supabase.from('rooms').update({ 
        round_state: 'NIGHT 1',
        logs: [], // 清空 JSON 缓存
        votes_received: {} 
    }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '游戏开始！' });
}