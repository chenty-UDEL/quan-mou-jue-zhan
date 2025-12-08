// api/submit-action.js - 接收玩家技能指令
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const { roomCode, actorId, targetId, actionType, roundNumber } = req.body;

    // 1. 简单校验
    if (!roomCode || !actorId || !actionType) {
        return res.status(400).json({ message: '缺少必要参数' });
    }

    // 2. 写入 night_actions 表
    const { data, error } = await supabase
        .from('night_actions')
        .insert([{
            room_code: roomCode,
            actor_id: actorId,
            target_id: targetId || null, // 允许无目标
            action_type: actionType,
            round_number: roundNumber || 1
        }])
        .select();

    if (error) {
        console.error('Action Error:', error);
        return res.status(500).json({ message: '提交行动失败', error: error.message });
    }

    // 3. 检查是否所有人已行动 (这是下一步 api/process-night 的工作，V0.3暂不触发)
    // 我们可以返回一个成功信号，前端收到后把按钮变灰
    res.status(200).json({ success: true, message: '行动已记录' });
}