// api/process-night.js - V0.7 升级版 (支持同盟/影子/沉默不禁技能)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });
    const { roomCode } = req.body;

    // 1. 获取数据
    const { data: players } = await supabase.from('players').select('*').eq('room_code', roomCode);
    const { data: actions } = await supabase.from('night_actions').select('*').eq('room_code', roomCode);

    if (!players || !actions) return res.status(500).json({ message: '读取数据失败' });

    let updates = {}; 
    let logs = [];
    
    // 2. 初始化 updates 对象
    // 【关键修改】我们需要保留之前的 flags (因为同盟/影子是永久绑定的)
    // 但必须清除"临时状态" (如今晚的守护、禁言)
    players.forEach(p => {
        const currentFlags = p.flags || {};
        
        // 创建一个新的 flags 对象，保留永久状态，移除临时状态
        const newFlags = { ...currentFlags };
        delete newFlags.is_protected; // 移除昨晚的守护
        delete newFlags.is_silenced;  // 移除昨晚的禁言
        delete newFlags.cannot_vote;  // 移除昨晚的禁票

        updates[p.id] = { 
            ...p, // 保留名字、角色等基础信息
            flags: newFlags
        };
    });

    // --- 3. 核心结算逻辑 ---

    // A. 限制类 (沉默/禁票)
    // 逻辑：只给目标挂状态，不影响目标发动技能
    actions.filter(a => ['silence', 'block_vote'].includes(a.action_type)).forEach(action => {
        const target = updates[action.target_id];
        if (target) {
            if (action.action_type === 'block_vote') {
                target.flags.cannot_vote = true;
                logs.push({ 
                    message: '你感到一股无形的力量阻止了你，明天你将无法投票。', 
                    viewer_ids: [action.target_id], 
                    tag: 'PRIVATE' 
                });
            }
            if (action.action_type === 'silence') {
                target.flags.is_silenced = true;
                logs.push({ 
                    message: '你被【沉默制裁者】禁言了！明天白天无法发言，但你的技能依然生效。', 
                    viewer_ids: [action.target_id], 
                    tag: 'PRIVATE' 
                });
            }
        }
    });

    // B. 防御类 (守护)
    actions.filter(a => a.action_type === 'protect').forEach(action => {
        const target = updates[action.target_id];
        if (target) {
            target.flags.is_protected = true;
            logs.push({ 
                message: `你成功守护了玩家 ${action.target_id}，他明天将免疫投票。`, 
                viewer_ids: [action.actor_id], 
                tag: 'PRIVATE' 
            });
        }
    });

    // C. 永久绑定类 (同盟/影子) - 这些技能通常只在第一夜发动
    actions.filter(a => ['ally_bind', 'shadow_bind'].includes(a.action_type)).forEach(action => {
        const actor = updates[action.actor_id];
        if (actor) {
            if (action.action_type === 'ally_bind') {
                actor.flags.ally_id = action.target_id;
                logs.push({ 
                    message: `契约已成！你已与玩家 ${action.target_id} 结为同盟。`, 
                    viewer_ids: [action.actor_id], 
                    tag: 'PRIVATE' 
                });
            }
            if (action.action_type === 'shadow_bind') {
                actor.flags.shadow_target_id = action.target_id;
                logs.push({ 
                    message: `目标锁定！你已选定玩家 ${action.target_id} 为你的影子目标。`, 
                    viewer_ids: [action.actor_id], 
                    tag: 'PRIVATE' 
                });
            }
        }
    });

    // D. 信息类 (查验)
    actions.filter(a => a.action_type === 'check').forEach(action => {
        const targetPlayer = players.find(p => p.id === action.target_id);
        if (targetPlayer) {
            logs.push({ 
                message: `观测结果：玩家【${targetPlayer.name}】的身份是【${targetPlayer.role}】。`, 
                viewer_ids: [action.actor_id], 
                tag: 'PRIVATE' 
            });
        }
    });

    // --- 4. 生成公告 ---
    const silencedCount = Object.values(updates).filter(u => u.flags.is_silenced).length;
    logs.push({
        message: silencedCount > 0 ? `天亮了。昨晚有 ${silencedCount} 名玩家被禁言。` : '天亮了，昨晚风平浪静。',
        viewer_ids: null, 
        tag: 'PUBLIC'
    });

    // --- 5. 提交数据库 ---
    const playerUpdates = Object.values(updates);
    const { error: updateError } = await supabase.from('players').upsert(playerUpdates);
    
    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({ 
            room_code: roomCode, 
            message: l.message, 
            viewer_ids: l.viewer_ids, 
            tag: l.tag 
        }));
        await supabase.from('game_logs').insert(logsPayload);
    }
    
    // 切换到白天 (尝试解析当前回合数)
    const { data: currentRoom } = await supabase.from('rooms').select('round_state').eq('code', roomCode).single();
    let nextRoundStr = 'DAY 1';
    if (currentRoom) {
        // 如果是 NIGHT 1 -> DAY 1, NIGHT 2 -> DAY 2
        const roundNum = parseInt(currentRoom.round_state.split(' ')[1]) || 1;
        nextRoundStr = `DAY ${roundNum}`;
    }

    await supabase.from('rooms').update({ round_state: nextRoundStr }).eq('code', roomCode);

    if (updateError) return res.status(500).json({ error: updateError.message });
    res.status(200).json({ success: true, message: '结算完成' });
}