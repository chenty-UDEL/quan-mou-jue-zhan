// api/process-night.js - V0.4 修正版 (控制优先/无夜间死亡)
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

    // 2. 初始化更新容器
    let updates = {}; 
    let logs = [];
    
    // 用 Set 记录本回合被废掉技能的玩家 ID
    let disabledActorIds = new Set();

    players.forEach(p => {
        updates[p.id] = { 
            id: p.id, 
            flags: {}, // 清空旧状态
            is_alive: p.is_alive 
        };
    });

    // --- 核心结算逻辑 (严格遵循优先级) ---

    // 🚫 优先级 1: 限制与干扰 (Silence / Block Vote)
    // 逻辑：先结算这些技能，如果生效，被指名的玩家不仅获得负面状态，且"当晚技能失效"
    const controlActions = actions.filter(a => ['silence', 'block_vote'].includes(a.action_type));
    
    controlActions.forEach(action => {
        const target = updates[action.target_id];
        if (target) {
            // 1.1 施加负面状态 (影响第二天白天)
            if (action.action_type === 'block_vote') {
                target.flags.cannot_vote = true;
                logs.push({ 
                    message: '你感到一股无形的力量阻止了你，明天你将无法投票。', 
                    viewer_ids: [action.target_id], tag: 'PRIVATE' 
                });
            }
            if (action.action_type === 'silence') {
                target.flags.is_silenced = true;
                // 关键逻辑：如果被沉默，他今晚的技能也同时失效（Role Block）
                disabledActorIds.add(action.target_id); 
                
                logs.push({ 
                    message: '你被【沉默制裁者】封印了！你今晚的技能失效，且明天无法发言。', 
                    viewer_ids: [action.target_id], tag: 'PRIVATE' 
                });
            }
        }
    });

    // 🛡️ 优先级 2: 防御构建 (Protect)
    // 逻辑：只有没被"沉默/封印"的守护者，技能才生效
    const protectActions = actions.filter(a => a.action_type === 'protect');
    
    protectActions.forEach(action => {
        // 检查：守护者是否被废了？
        if (disabledActorIds.has(action.actor_id)) {
            // 被沉默了，技能无效，跳过
            return; 
        }

        const target = updates[action.target_id];
        if (target) {
            target.flags.is_protected = true; // 标记无敌 (用于白天抵消票数)
            
            // 守护者收到成功反馈
            logs.push({
                message: `你成功守护了玩家 ${action.target_id}，他明天将免疫投票。`,
                viewer_ids: [action.actor_id], tag: 'PRIVATE'
            });
        }
    });

    // 👁️ 优先级 3: 信息获取 (Check)
    // 逻辑：同样受沉默影响
    const checkActions = actions.filter(a => a.action_type === 'check');
    
    checkActions.forEach(action => {
        // 检查：观测者是否被废了？
        if (disabledActorIds.has(action.actor_id)) {
            return; 
        }

        const targetPlayer = players.find(p => p.id === action.target_id);
        if (targetPlayer) {
            logs.push({
                message: `观测结果：玩家【${targetPlayer.name}】的身份是【${targetPlayer.role}】。`,
                viewer_ids: [action.actor_id], tag: 'PRIVATE'
            });
        }
    });

    // 📝 优先级 4: 生成公共公告 (没有死亡)
    // 根据规则，夜晚不死人，只可能有状态变化
    // 这里可以统计一下有多少人被禁言（但不说是谁），增加紧张感
    const silencedCount = Object.values(updates).filter(u => u.flags.is_silenced).length;
    let publicMsg = '天亮了，昨晚风平浪静。';
    if (silencedCount > 0) {
        publicMsg = `天亮了。昨晚有 ${silencedCount} 名玩家遭遇了神秘力量的干扰（被禁言/封印）。`;
    }

    logs.push({
        message: publicMsg,
        viewer_ids: null, // 公开
        tag: 'PUBLIC'
    });

    // --- 提交更改 ---

    // 1. 更新玩家状态
    const playerUpdates = Object.values(updates);
    const { error: updateError } = await supabase.from('players').upsert(playerUpdates);

    // 2. 插入日志
    if (logs.length > 0) {
        const logsPayload = logs.map(l => ({
            room_code: roomCode,
            message: l.message,
            viewer_ids: l.viewer_ids,
            tag: l.tag,
            round_number: 1 // TODO: 需动态获取
        }));
        await supabase.from('game_logs').insert(logsPayload);
    }

    // 3. 切换到白天
    await supabase.from('rooms').update({ round_state: 'DAY 1' }).eq('code', roomCode);

    if (updateError) return res.status(500).json({ error: updateError.message });
    res.status(200).json({ success: true, message: '结算完成，进入白天' });
}