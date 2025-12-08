// api/submit-vote.js - 处理白天投票
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    const { roomCode, voterId, targetId } = req.body;

    // 1. 检查玩家是否存活 & 是否被禁止投票
    const { data: player } = await supabase
        .from('players')
        .select('is_alive, flags')
        .eq('id', voterId)
        .single();

    if (!player || !player.is_alive) {
        return res.status(400).json({ message: '你已出局，无法投票' });
    }

    // --- 关键逻辑：检查 cannot_vote 标记 ---
    // 这是昨晚被"投票阻断者"技能命中的结果
    if (player.flags && player.flags.cannot_vote) {
        return res.status(403).json({ message: '你被【投票阻断者】限制，今日无法投票！' });
    }

    // 2. 提交投票
    // 使用 upsert，确保每人每轮只能投一次 (覆盖旧票)
    const { error } = await supabase
        .from('votes')
        .upsert({
            room_code: roomCode,
            voter_id: voterId,
            target_id: targetId || null, // null 代表弃票
            round_number: 1 // V0.6 会做动态回合
        }, { onConflict: 'room_code, voter_id, round_number' });

    if (error) {
        return res.status(500).json({ message: '投票失败', error: error.message });
    }

    res.status(200).json({ success: true, message: '投票已记录' });
}