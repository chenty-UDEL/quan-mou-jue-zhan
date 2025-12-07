// api/start-game.js - Vercel Serverless Function
import { supabase } from '../lib/supabaseClient';

// V0.2 角色配置
const V02_ROLES = [
    '技能观测者', 
    '利他守护者', 
    '沉默制裁者', 
    '投票阻断者', 
    '双票使者',   
    '三人王者', 
    // 为了支持更多人，我们可以重复添加或者添加更多角色
    '平民', '平民', '平民', '平民', '平民', '平民', '平民'  
];

const shuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const { roomCode } = req.body;

    // 1. 获取玩家列表
    const { data: players, error: playersError } = await supabase
        .from('players')
        .select('*')
        .eq('room_code', roomCode);

    if (playersError || !players) {
        return res.status(500).json({ error: playersError?.message || '无法获取玩家列表' });
    }

    const numPlayers = players.length;

    // --- 修改点：验证人数改为 2 人 ---
    if (numPlayers < 2) {
        return res.status(400).json({ message: '人数不足 2 人，无法开始游戏。' });
    }

    // 2. 准备角色池并洗牌
    // 确保角色池够用
    let availableRoles = [...V02_ROLES];
    if (numPlayers > availableRoles.length) {
         // 如果人太多，角色不够，补充平民
         const diff = numPlayers - availableRoles.length;
         for(let i=0; i<diff; i++) availableRoles.push('平民');
    }

    let rolesToAssign = availableRoles.slice(0, numPlayers); 
    shuffle(rolesToAssign);

    const updates = players.map((player, index) => ({
        id: player.id,
        role: rolesToAssign[index],
        is_alive: true,
    }));

    // 3. 更新玩家角色
    const { error: updateError } = await supabase.from('players').upsert(updates);
    
    // 4. 更新房间状态
    const { error: roomUpdateError } = await supabase
        .from('rooms')
        .update({ round_state: 'NIGHT 1', roles_in_play: rolesToAssign })
        .eq('code', roomCode);

    if (updateError || roomUpdateError) {
        return res.status(500).json({ error: updateError?.message || roomUpdateError?.message });
    }

    res.status(200).json({ success: true, message: '游戏已开始' });
}