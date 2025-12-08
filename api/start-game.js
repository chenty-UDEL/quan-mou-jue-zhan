// api/start-game.js - V0.8 (完整角色池配置)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

// 📜 V0.8 完整角色列表 (15个已实现角色)
// 包含: 基础类、防御类、干扰类、数值类、特殊胜利类、历史记录类
const ROLES = [
    // 1. 基础与主动技能类
    '技能观测者', 
    '利他守护者', 
    '投票阻断者', 
    '沉默制裁者',
    '同盟者',       // Night 1 绑定

    // 2. 被动数值与防御类
    '减票守护者', 
    '双票使者', 

    // 3. 特殊胜利 - 状态/局面类
    '三人王者',     // 剩3人赢
    '集票胜者',     // 得票>2/3赢
    '平票赢家',     // 平票且在其中赢
    '影子胜者',     // 前后一回合死赢 (V0.8 重写版)

    // 4. 特殊胜利 - 历史计数器类
    '平票终结者',   // 连续平票赢
    '免票胜者',     // 连续0票赢
    '票数平衡者',   // 连续得票相同赢 (V0.8 新增)
    '多选胜者',     // 连续投死不同人赢 (V0.8 新增)
    
    // 如果房间人数超过15人，下面的会被填充为普通玩家
    '普通玩家', '普通玩家'
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
    
    // 如果玩家人数比角色多，补充普通玩家
    while (shuffledRoles.length < players.length) {
        shuffledRoles.push('普通玩家');
    }
    
    // 彻底打乱数组
    for (let i = shuffledRoles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRoles[i], shuffledRoles[j]] = [shuffledRoles[j], shuffledRoles[i]];
    }

    // 3. 分配角色并初始化状态
    const updates = players.map((player, index) => ({
        id: player.id,
        room_code: roomCode,
        name: player.name, 
        role: shuffledRoles[index],
        is_alive: true,
        death_round: null, // V0.8 新增: 死亡回合重置
        death_type: null,  // V0.8 新增: 死亡类型重置
        flags: {}          // 必须重置! 防止上一局的计数器(streak)带入
    }));

    // 4. 更新数据库
    
    // 4.1 更新玩家表
    const { error: updateError } = await supabase.from('players').upsert(updates);
    if (updateError) return res.status(500).json({ message: '分发角色失败', error: updateError.message });

    // 4.2 清空旧数据 (投票、行动、日志)
    await supabase.from('votes').delete().eq('room_code', roomCode);
    await supabase.from('night_actions').delete().eq('room_code', roomCode);
    await supabase.from('game_logs').delete().eq('room_code', roomCode);

    // 4.3 更新房间状态 -> 进入第一夜
    await supabase.from('rooms').update({ 
        round_state: 'NIGHT 1',
        logs: [], 
        votes_received: {} 
    }).eq('code', roomCode);

    res.status(200).json({ success: true, message: '游戏开始！' });
}