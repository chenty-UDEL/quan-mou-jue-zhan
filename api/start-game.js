// api/start-game.js - Vercel Serverless Function
import { supabase } from '../lib/supabaseClient';

// 固定的简单角色配置 (为了V0.2快速测试，我们只用6个角色)
const V02_ROLES = [
    [cite_start]'技能观测者', // Skill Observer [cite: 20]
    [cite_start]'利他守护者', // Altruistic Guardian [cite: 21]
    [cite_start]'沉默制裁者', // Silence Sanctioner [cite: 23]
    [cite_start]'投票阻断者', // Vote Blocker [cite: 22]
    [cite_start]'双票使者',   // Double Voter (Passive) [cite: 26]
    [cite_start]'三人王者',   // Three Kings (Special Win Condition) [cite: 30]
];

// 简单的Fisher-Yates洗牌算法
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
        return res.status(500).json({ error: playersError.message });
    }

    const numPlayers = players.length;

    [cite_start]// 验证人数：权谋决战要求 6-13 人 [cite: 5]
    if (numPlayers < 6) {
        return res.status(400).json({ message: '人数不足 6 人，无法开始游戏。' });
    }

    // 2. 准备角色池并洗牌
    let rolesToAssign = V02_ROLES.slice(0, numPlayers); // 只取所需数量的角色
    if (rolesToAssign.length < numPlayers) {
        // 如果玩家多于角色池，这里需要补充普通角色，但V0.2我们假设玩家不会超过6人
        // 生产环境应该从V02_ROLES中循环或添加通用角色
    }
    shuffle(rolesToAssign);

    const updates = players.map((player, index) => ({
        id: player.id,
        role: rolesToAssign[index],
        // 重置状态
        is_alive: true,
        role_skill: null, // 可以在这里设置角色的初始技能状态
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

    res.status(200).json({ success: true, message: '游戏已开始，进入夜晚阶段。' });
}